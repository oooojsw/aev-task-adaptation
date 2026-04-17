#!/usr/bin/env python3
"""Final verification of generated documents"""
import zipfile
import re
import os

OUTPUT_DIR = r"C:\Users\ZhuanZ\Desktop\opencode re\opencode latest\auto-evolve\task-packs\real-long-tasks\try4-expert-bootstrap\deployment\outputs"

def check_docx(path, doc_type):
    print(f"\n=== Checking {doc_type} ===")
    print(f"Path: {path}")
    print(f"Exists: {os.path.exists(path)}")
    
    if not os.path.exists(path):
        return False
    
    # Check if valid zip
    try:
        with zipfile.ZipFile(path, 'r') as z:
            # Check for required files
            namelist = z.namelist()
            has_doc_xml = 'word/document.xml' in namelist
            print(f"Valid ZIP: True")
            print(f"Has word/document.xml: {has_doc_xml}")
            
            # Read document.xml
            with z.open('word/document.xml') as f:
                content = f.read().decode('utf-8')
            
            # Find placeholders using Unicode chars
            LEFT = '\u300a'  # 【
            RIGHT = '\u300b'  # 】
            
            # Count bracket characters
            left_count = content.count(LEFT)
            right_count = content.count(RIGHT)
            print(f"LEFT bracket (【) count: {left_count}")
            print(f"RIGHT bracket (】) count: {right_count}")
            
            # Find continuous placeholders
            continuous = re.findall(r'【[^】]*】', content)
            print(f"Continuous 【...】 patterns: {len(continuous)}")
            
            # Show unique placeholders
            if continuous:
                unique = set(continuous)
                print(f"Unique placeholders ({len(unique)}):")
                for p in sorted(unique)[:10]:
                    print(f"  {p}")
                if len(unique) > 10:
                    print(f"  ... and {len(unique) - 10} more")
            
            # Check for key values
            key_values = ['20260', '20665', '20,260', '20,665', '南京恩瑞特', 'HUACHEN', '2026年3月23日']
            print("\nKey values present:")
            for val in key_values:
                present = val in content
                if present:
                    print(f"  {val}: YES")
            
            # Return True if no placeholders remain
            has_placeholders = left_count > 0 or right_count > 0 or len(continuous) > 0
            return not has_placeholders
    except Exception as e:
        print(f"Error: {e}")
        return False

# Check both files
report_ok = check_docx(os.path.join(OUTPUT_DIR, "generated-report.docx"), "Report")
exp_ok = check_docx(os.path.join(OUTPUT_DIR, "generated-explanation.docx"), "Explanation")

print("\n=== SUMMARY ===")
print(f"Report: {'PASS' if report_ok else 'FAIL'}")
print(f"Explanation: {'PASS' if exp_ok else 'FAIL'}")
