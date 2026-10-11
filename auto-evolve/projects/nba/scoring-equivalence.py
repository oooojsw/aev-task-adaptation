"""Offline differential against pinned upstream AST; never imports its API runner."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path

UPSTREAM = Path('E:/project/RuleArena-upstream/nba/auto_test.py')
EXPECTED = '8a8677c36579dd945f978da8cd8eed264d5072cb719fa6f1e260ef9aceb2e29c'


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def main():
    raw = UPSTREAM.read_bytes()
    if hashlib.sha256(raw).hexdigest() != EXPECTED:
        raise ValueError('Upstream source changed; review scoring statements first')
    tree = ast.parse(raw.decode('utf-8-sig'))
    acc = next(node for node in ast.walk(tree) if isinstance(node, ast.Assign) and
               any(isinstance(target, ast.Name) and target.id == 'acc' for target in node.targets))
    assignments = [node for node in ast.walk(tree) if isinstance(node, ast.Assign) and
                   node.lineno < acc.lineno and node.lineno >= acc.lineno - 12]
    clean = next(node for node in assignments if any(isinstance(target, ast.Name) and target.id == 'response'
                                                   for target in node.targets) and isinstance(node.value, ast.Call)
                 and isinstance(node.value.func, ast.Attribute) and node.value.func.attr == 'replace')
    answer = next(node for node in assignments if any(isinstance(target, ast.Name) and target.id == 'answer'
                                                    for target in node.targets))
    conditional = next(node for node in ast.walk(tree) if isinstance(node, ast.If) and
                       answer.lineno < node.lineno < acc.lineno and
                       isinstance(node.test, ast.UnaryOp) and isinstance(node.test.operand, ast.Name)
                       and node.test.operand.id == 'answer')
    # 只执行纯评分语句，不导入官方模型调用、命令行或文件写入。
    pure = compile(ast.fix_missing_locations(ast.Module(body=[clean, answer, conditional, acc], type_ignores=[])), str(UPSTREAM), 'exec')
    here = Path(__file__).resolve().parent
    official = module('official', here / 'official-scorer.py')
    local = module('local', here / 'scorer.py')
    legal = {'answer': False}
    illegal = {'answer': True, 'illegal_operation': 'A', 'problematic_team': 'B'}
    texts = ['', 'Answer: False', '**Answer: False**', 'answer: false', 'Answer : False',
             'Answer: Falsehood', 'Answer: True. Illegal Operation: A. Problematic Team: B',
             'Answer: True. Illegal Operation: C. Problematic Team: B',
             'Answer: True\nIllegal Operation: A\nProblematic Team: B',
             'Answer: True. Illegal Operation: A. Problematic Team: B\nAnswer: False',
             'Answer: False\nAnswer: True. Illegal Operation: A. Problematic Team: B']
    differences = []
    for gold in [legal, illegal]:
        for text in texts:
            scope = {'response': text, 'query_dict': gold}
            exec(pure, scope)
            if official.evaluate(text, gold) != scope['acc']:
                raise AssertionError('Official adapter differs from upstream')
            if local.evaluate(text, gold) != scope['acc']:
                differences.append({'text': text, 'gold': gold, 'official': bool(scope['acc']), 'local': local.evaluate(text, gold)})
    if not differences:
        raise AssertionError('Expected scoring-mode distinctions missing')
    print(json.dumps({'cases': len(texts) * 2, 'upstreamSHA256': EXPECTED, 'equivalent': True, 'differences': differences}))


if __name__ == '__main__':
    main()
