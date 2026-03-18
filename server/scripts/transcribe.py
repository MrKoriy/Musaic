#!/usr/bin/env python3
"""
Musaic AI Lyrics Transcription Pipeline

Usage:
    python transcribe.py <audio_path> <output_lrc_path> [--openrouter-key KEY]

Pipeline:
    1. Demucs (htdemucs) — vocal separation
    2. Parakeet TDT v3 (nvidia/parakeet-tdt-0.6b-v3) — ASR with word timestamps
    3. LLM cleanup via OpenRouter (optional) — fix punctuation/capitalization
    4. Output: LRC format with line timestamps

Requirements:
    pip install demucs nemo_toolkit[asr] requests
"""

import sys
import os
import json
import re
import tempfile
import argparse
import subprocess
from pathlib import Path


def run_demucs(audio_path: str, output_dir: str) -> str:
    """Run Demucs htdemucs model for vocal separation. Returns path to vocals file."""
    print("[demucs] Running vocal separation...", flush=True)
    result = subprocess.run(
        [
            sys.executable, "-m", "demucs",
            "--two-stems=vocals",
            "--model", "htdemucs",
            "--out", output_dir,
            audio_path,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"[demucs] Error: {result.stderr}", file=sys.stderr)
        raise RuntimeError(f"Demucs failed: {result.stderr}")

    # Find the vocals file (demucs outputs to output_dir/htdemucs/<stem>/<name>/vocals.wav)
    stem_name = Path(audio_path).stem
    vocals_path = Path(output_dir) / "htdemucs" / stem_name / "vocals.wav"
    if not vocals_path.exists():
        # Try without stem_name folder (newer demucs versions)
        for candidate in Path(output_dir).rglob("vocals.wav"):
            return str(candidate)
        raise FileNotFoundError(f"Vocals file not found in {output_dir}")
    return str(vocals_path)


def run_parakeet(vocals_path: str) -> list[dict]:
    """Run Parakeet TDT v3 ASR. Returns list of {word, start, end} dicts."""
    print("[parakeet] Loading Parakeet TDT v3 ASR model...", flush=True)
    try:
        import nemo.collections.asr as nemo_asr
    except ImportError:
        raise ImportError(
            "NeMo toolkit not installed. Run: pip install nemo_toolkit[asr]"
        )

    model = nemo_asr.models.ASRModel.from_pretrained("nvidia/parakeet-tdt-0.6b-v3")
    model.eval()

    print("[parakeet] Transcribing vocals...", flush=True)
    output = model.transcribe(
        [vocals_path],
        return_hypotheses=True,
        timestamps=True,
    )

    # Extract word-level timestamps
    hypothesis = output[0] if isinstance(output, list) else output
    words = []

    if hasattr(hypothesis, "timestamp") and hypothesis.timestamp:
        ts = hypothesis.timestamp
        word_list = ts.get("word", [])
        for w in word_list:
            words.append({
                "word": w["word"],
                "start": w["start_offset"] if "start_offset" in w else w.get("start", 0),
                "end": w["end_offset"] if "end_offset" in w else w.get("end", 0),
            })
    else:
        # Fallback: no word timestamps — use sentence-level if available
        text = hypothesis.text if hasattr(hypothesis, "text") else str(hypothesis)
        words = [{"word": w, "start": 0, "end": 0} for w in text.split()]

    return words


def words_to_lines(words: list[dict], max_line_duration: float = 5.0) -> list[dict]:
    """
    Group words into lyric lines based on pauses between words.
    Returns list of {time_sec, text} dicts.
    """
    if not words:
        return []

    lines = []
    current_line_words = []
    current_line_start = words[0]["start"]

    for i, w in enumerate(words):
        current_line_words.append(w["word"])

        is_last = i == len(words) - 1
        gap_to_next = words[i + 1]["start"] - w["end"] if not is_last else float("inf")

        # Start a new line on significant pause (>0.8s) or max line duration
        line_duration = w["end"] - current_line_start
        if gap_to_next > 0.8 or line_duration > max_line_duration or is_last:
            text = " ".join(current_line_words)
            lines.append({"time_sec": current_line_start, "text": text})
            current_line_words = []
            if not is_last:
                current_line_start = words[i + 1]["start"]

    return lines


def llm_cleanup(lines: list[dict], openrouter_key: str) -> list[dict]:
    """Use OpenRouter LLM to fix capitalization, punctuation, and merge broken lines."""
    import urllib.request
    import urllib.error

    print("[llm] Post-processing lyrics with LLM...", flush=True)
    plain_text = "\n".join(line["text"] for line in lines)

    payload = json.dumps({
        "model": "google/gemma-3-4b-it:free",
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a lyrics editor. Fix capitalization, punctuation, and grammar "
                    "in these song lyrics. Keep the same number of lines. "
                    "Do not add or remove lines. Only fix the text."
                ),
            },
            {"role": "user", "content": plain_text},
        ],
        "max_tokens": 2000,
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {openrouter_key}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            cleaned = data["choices"][0]["message"]["content"]
            cleaned_lines = cleaned.strip().split("\n")

            # Map cleaned text back to original timestamps
            result = []
            for i, line in enumerate(lines):
                text = cleaned_lines[i].strip() if i < len(cleaned_lines) else line["text"]
                result.append({"time_sec": line["time_sec"], "text": text})
            return result
    except Exception as e:
        print(f"[llm] LLM cleanup failed, using raw transcription: {e}", file=sys.stderr)
        return lines


def lines_to_lrc(lines: list[dict]) -> str:
    """Convert list of {time_sec, text} to LRC format string."""
    lrc_lines = []
    for line in lines:
        t = line["time_sec"]
        minutes = int(t // 60)
        seconds = t % 60
        tag = f"[{minutes:02d}:{seconds:05.2f}]"
        lrc_lines.append(f"{tag} {line['text']}")
    return "\n".join(lrc_lines)


def main():
    parser = argparse.ArgumentParser(description="Musaic AI lyrics transcription pipeline")
    parser.add_argument("audio_path", help="Path to audio file (MP3, FLAC, M4A, etc.)")
    parser.add_argument("output_lrc", help="Output LRC file path")
    parser.add_argument("--openrouter-key", default=os.environ.get("OPENROUTER_API_KEY", ""), help="OpenRouter API key for LLM cleanup")
    parser.add_argument("--skip-demucs", action="store_true", help="Skip vocal separation (use audio directly)")
    args = parser.parse_args()

    if not os.path.exists(args.audio_path):
        print(f"Error: audio file not found: {args.audio_path}", file=sys.stderr)
        sys.exit(1)

    with tempfile.TemporaryDirectory() as tmpdir:
        # Step 1: Vocal separation
        if args.skip_demucs:
            vocals_path = args.audio_path
        else:
            try:
                vocals_path = run_demucs(args.audio_path, tmpdir)
            except Exception as e:
                print(f"[demucs] Vocal separation failed, using original: {e}", file=sys.stderr)
                vocals_path = args.audio_path

        # Step 2: ASR transcription
        words = run_parakeet(vocals_path)
        if not words:
            print("Error: No transcription output", file=sys.stderr)
            sys.exit(2)

        # Step 3: Group into lines
        lines = words_to_lines(words)

        # Step 4: LLM cleanup (optional)
        if args.openrouter_key and lines:
            lines = llm_cleanup(lines, args.openrouter_key)

        # Step 5: Write LRC
        lrc = lines_to_lrc(lines)
        with open(args.output_lrc, "w", encoding="utf-8") as f:
            f.write(lrc)

        print(f"[transcribe] Done — {len(lines)} lines written to {args.output_lrc}")
        # Also print to stdout for server to capture
        print(lrc)


if __name__ == "__main__":
    main()
