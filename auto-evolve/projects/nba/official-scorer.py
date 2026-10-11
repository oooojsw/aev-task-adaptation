"""Explicit RuleArena NBA upstream string-match scoring, not last-answer parsing."""
import hashlib
import json
import re
import sys
from pathlib import Path


def read(item):
    raw = Path(item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Artifact drift')
    return raw.decode('utf-8-sig')


def evaluate(text, gold):
    # 保留官方字符串命中行为；不能静默替换为最后答案规则。
    response = text.replace('**', '')
    if not gold['answer']:
        target = 'Answer: False'
    else:
        target = (f'Answer: True. Illegal Operation: {gold["illegal_operation"]}. '
                  f'Problematic Team: {gold["problematic_team"]}')
    return target in response


def main():
    try:
        payload = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
        if payload['check']['target'] != 'product' or len(payload['candidate']) != 1:
            raise ValueError('One explicit execution product required')
        labels = [item for item in payload['privateInputs'] if item['id'] == 'gold']
        if len(labels) != 1:
            raise ValueError('One explicit gold input required')
        gold = json.loads(read(labels[0]))
        if type(gold.get('answer')) is not bool:
            raise ValueError('Invalid label')
        if gold['answer'] and any(not isinstance(gold.get(key), str) or not re.fullmatch('[A-Z]', gold[key])
                                  for key in ('illegal_operation', 'problematic_team')):
            raise ValueError('Invalid operation/team')
        passed = evaluate(read(payload['candidate'][0]), gold)
        result = dict(status='passed' if passed else 'rejected',
                      message='NBA upstream string-match passed.' if passed else 'NBA upstream string-match rejected.')
    except Exception:
        result = dict(status='data_error', message='NBA explicit input or label validation failed.')
    print(json.dumps(result, allow_nan=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
