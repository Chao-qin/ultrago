import argparse
import io
import sys
from importlib.metadata import version
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def check_runtime():
    expected_python = (PROJECT_ROOT / '.python-version').read_text().strip()
    actual_python = '.'.join(map(str, sys.version_info[:3]))
    if actual_python != expected_python:
        raise RuntimeError(f'Python 版本不匹配：需要 {expected_python}，实际 {actual_python}')
    if Path(sys.prefix).resolve() != (PROJECT_ROOT / '.venv').resolve():
        raise RuntimeError('解释器未使用项目 .venv')
    import tomllib
    with (PROJECT_ROOT / 'uv.lock').open('rb') as stream:
        lock = tomllib.load(stream)
    for package in lock['package']:
        if 'registry' not in package.get('source', {}):
            continue
        actual = version(package['name'])
        if actual != package['version']:
            raise RuntimeError(f"{package['name']} 版本不匹配：需要 {package['version']}，实际 {actual}")
    actual_pillow = version('Pillow')
    from PIL import ImageFont
    font = ImageFont.load_default(size=28)
    if font.size != 28:
        raise RuntimeError('Pillow 无法加载 28 号字体')
    return actual_python, actual_pillow


def check_montage():
    from PIL import Image
    sys.path.insert(0, str(PROJECT_ROOT / '.claude/skills/product-preprocess/projection'))
    from vision_montage import build_montages
    source = io.BytesIO()
    Image.new('RGB', (64, 64), 'white').save(source, 'PNG')
    tasks = build_montages([(source.getvalue(), '/images/main/0')])
    with Image.open(io.BytesIO(tasks[0].image)) as image:
        if image.size != (2000, 2000):
            raise RuntimeError('图片拼图尺寸校验失败')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--montage', action='store_true')
    parser.add_argument('--report', action='store_true')
    args = parser.parse_args()
    try:
        python_version, pillow_version = check_runtime()
        if args.montage:
            check_montage()
    except Exception as exc:
        print(f'[python] {exc}；请在项目根目录执行 pnpm python:setup', file=sys.stderr)
        return 1
    if args.report:
        print(f'Python {python_version} / Pillow {pillow_version} / {sys.prefix}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
