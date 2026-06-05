#!/usr/bin/env python3
"""Check that the generated audit opinion draft exists and is not empty."""
import json
import sys
import os
import glob

def find_docx(base_dir):
    """Find any .docx file in the given directory (handles garbled Windows Chinese paths)."""
    if not os.path.isdir(base_dir):
        return None
    # Try exact Chinese filename first
    candidates = [
        "浙江哈工机器人有限公司股权价值内部审核意见-草稿.docx",
        "内部审核意见-草稿.docx",
    ]
    for name in candidates:
        p = os.path.join(base_dir, name)
        if os.path.exists(p):
            return p
    # Fallback: find any .docx that looks like an audit opinion
    for entry in os.listdir(base_dir):
        if entry.lower().endswith(".docx") and os.path.getsize(os.path.join(base_dir, entry)) > 100:
            return os.path.join(base_dir, entry)
        if entry.lower().endswith(".doc") and os.path.getsize(os.path.join(base_dir, entry)) > 100:
            return os.path.join(base_dir, entry)
    return None

def main():
    # Read input from validator_input.json
    input_file = sys.argv[1] if len(sys.argv) > 1 else None
    if input_file and os.path.exists(input_file):
        with open(input_file, "r", encoding="utf-8") as f:
            input_data = json.load(f)
    else:
        input_data = {}

    # Try to find the output path from the validator input
    output_path = None

    # Method 1: check targetPaths in the input
    target_paths = input_data.get("targetPaths", [])
    for tp in target_paths:
        if isinstance(tp, dict):
            p = tp.get("path", "")
        else:
            p = str(tp)
        if p and os.path.exists(p):
            output_path = p
            break

    # Method 2: check expectedArtifacts
    if not output_path:
        for artifact in input_data.get("expectedArtifacts", []):
            if os.path.exists(str(artifact)):
                output_path = str(artifact)
                break

    # Method 3: scan output directories near the input file
    if not output_path and input_file:
        # Look in deployment/outputs/ first
        deployment_dir = os.path.dirname(os.path.dirname(os.path.dirname(input_file)))
        for subdir in ["outputs", "output"]:
            found = find_docx(os.path.join(deployment_dir, subdir))
            if found:
                output_path = found
                break

    # Method 4: scan the script's parent directory (original behavior, fallback)
    if not output_path:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for subdir in ["outputs", "output"]:
            found = find_docx(os.path.join(base, subdir))
            if found:
                output_path = found
                break

    if not output_path:
        result = {
            "passed": False,
            "summary": "Generated audit opinion file not found in output/ or outputs/ directory",
            "details": ["No .docx or .doc file found matching the expected audit opinion output."],
            "blocking": True
        }
    else:
        try:
            size = os.path.getsize(output_path)
        except OSError:
            result = {
                "passed": False,
                "summary": f"Cannot read file: {output_path}",
                "details": [f"File exists but cannot be accessed: {output_path}"],
                "blocking": True
            }
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 1

        if size < 100:
            result = {
                "passed": False,
                "summary": f"Generated file is too small ({size} bytes), likely empty or corrupted",
                "details": [f"File: {output_path}", f"Size: {size} bytes"],
                "blocking": True
            }
        else:
            result = {
                "passed": True,
                "summary": f"Generated audit opinion file exists and has content ({size} bytes)",
                "details": [f"File: {output_path}", f"Size: {size} bytes"],
                "blocking": True
            }

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("passed") else 1

if __name__ == "__main__":
    sys.exit(main())
