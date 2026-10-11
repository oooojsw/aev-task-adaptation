"""NBA project scoring adapter; preserves the existing local last-answer rule."""
import hashlib
import json
import re
import sys
from pathlib import Path

ANSWER = re.compile(r'Answer\s*:\s*(True|False)\b', re.IGNORECASE)
OPERATION = re.compile(r'Illegal Operation\s*:\s*([A-Z])\b', re.IGNORECASE)
TEAM = re.compile(r'Problematic Team\s*:\s*([A-Z])\b', re.IGNORECASE)


def read(item):
    raw = Path(item['path']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('Artifact drift')
    return raw.decode('utf-8-sig')


def evaluate(text, gold):
    cleaned = text.replace('**', '')
    answers = list(ANSWER.finditer(cleaned))
    if not answers:
        return False
    answer = answers[-1]
    illegal = answer.group(1).lower() == 'true'
    suffix = cleaned[answer.end():]
    operation, team = OPERATION.search(suffix), TEAM.search(suffix)
    if illegal != gold['answer']:
        return False
    return not illegal or (operation is not None and team is not None and
        operation.group(1).upper() == gold['illegal_operation'] and
        team.group(1).upper() == gold['problematic_team'])


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
                      message='NBA product passed.' if passed else 'NBA product rejected.')
    except Exception:
        result = dict(status='data_error', message='NBA explicit input or label validation failed.')
    print(json.dumps(result, allow_nan=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
