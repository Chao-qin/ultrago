import sys
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PREPROCESS_ROOT = PROJECT_ROOT / '.claude/skills/product-preprocess'


def deny_network(event, _args):
    if event == 'socket.connect':
        raise OSError('Network is disabled in offline Python tests')


def main():
    suite = Path(sys.argv[1]).resolve()
    # 历史测试既用包导入也用平级导入，且存在同名测试模块，需要逐文件隔离。
    sys.path[:0] = [str(suite.parent), str(PREPROCESS_ROOT),
                    str(PREPROCESS_ROOT / 'projection'), str(PREPROCESS_ROOT / 'scripts')]
    sys.addaudithook(deny_network)
    tests = unittest.defaultTestLoader.discover(str(suite.parent), pattern=suite.name)
    result = unittest.TextTestRunner().run(tests)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
