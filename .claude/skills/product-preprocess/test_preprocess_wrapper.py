"""flow 适配器 preprocess_wrapper 的契约。

flow 的 script 节点只取 stdout **最后一行**做 JSON.parse，退出码非 0 时根本不解析
（flow-runner.service.ts:1297）。这两条决定了适配器的全部设计，在这里钉死——
不依赖 LLM，通道拥塞时也能验。
"""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parent / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preprocess_wrapper as W


class PersistTests(unittest.TestCase):
    def test_不给persist时只返回body不落盘(self):
        req = W.decode_request(json.dumps({"raw": {"a": 1}}))
        self.assertIsNone(req["persist_path"])

    def test_file_persist_只接受仓库内相对路径(self):
        got = W.resolve_persist_path({"kind": "file", "path": "reports/processed/x.json"})
        self.assertTrue(got.is_absolute())
        self.assertTrue(str(got).endswith("reports/processed/x.json"))

    def test_拒绝绝对路径(self):
        with self.assertRaises(ValueError) as c:
            W.resolve_persist_path({"kind": "file", "path": "/tmp/anywhere"})
        self.assertIn("绝对路径", str(c.exception))

    def test_拒绝逃出仓库(self):
        """outDir 来自 flow 入参，而入参可能来自上游任意节点。"""
        with self.assertRaises(ValueError) as c:
            W.resolve_persist_path({"kind": "file", "path": "../../etc"})
        self.assertIn("逃出", str(c.exception))

    def test_拒绝空值与非字符串(self):
        for bad in ("", "   ", 123, []):
            with self.assertRaises(ValueError):
                W.resolve_persist_path({"kind": "file", "path": bad})

    def test_未知字段仍然被拒(self):
        with self.assertRaises(ValueError) as c:
            W.decode_request(json.dumps({"raw": {}, "nope": 1}))
        self.assertIn("未知字段", str(c.exception))


class ProfileTests(unittest.TestCase):
    def test_显式profile进入预处理并覆盖默认配置(self):
        profile = {"freightTemplateId": "freight-1", "serviceMobile": "13800138000"}
        request = W.decode_request(json.dumps({"raw": {"a": 1}, "profile": profile}))
        self.assertEqual(request["profile"], profile)

        with mock.patch.object(W, "build_doudian_product", return_value={"canonical": {}, "pending": []}) as build:
            W.process_product(request)

        self.assertEqual(build.call_args.kwargs["profile"], profile)

    def test_profile必须是object(self):
        with self.assertRaises(ValueError) as c:
            W.decode_request(json.dumps({"raw": {}, "profile": "not-a-profile"}))
        self.assertIn("profile 必须是 JSON object", str(c.exception))

    def test_mode只允许两个发布落点(self):
        self.assertEqual(W.decode_request(json.dumps({"raw": {}, "mode": "draft"}))["mode"], "draft")
        with self.assertRaises(ValueError):
            W.decode_request(json.dumps({"raw": {}, "mode": "invalid"}))


class OutputContractTests(unittest.TestCase):
    RESULT = {
        "canonical": {"category": {"doudianPath": ["服装", "女装", "T恤/Polo衫"]}},
        'publication': {'canPublish': False, 'canDraft': True, 'missingRequired': ['资质']},
        "projection_verdict": {"status": "needs_human", "reason": "13 项风险"},
        "projection_error": None,
    }

    def test_needs_human_不是运行失败(self):
        """flow 在退出码非 0 时不解析 JSON，而 needs_human 是绝大多数商品的正常结局。"""
        out = W.build_output(self.RESULT)
        self.assertEqual(out['outcome']['status'], 'needs_input')
        self.assertTrue(out['publication']['canDraft'])

    def test_通道不可用与检测通过严格区分(self):
        out = W.build_output({**self.RESULT, "projection_error": "opencode 超时"})
        self.assertEqual(out['outcome']['status'], 'blocked')
        self.assertEqual(out['outcome']['reason'], 'opencode 超时')

    def test_中文不转义便于人读(self):
        self.assertIn("女装", json.dumps(W.build_output(self.RESULT), ensure_ascii=False))

    def test_产出没有额外商品副本(self):
        self.assertEqual(set(W.build_output(self.RESULT)), {'canonical', 'publication', 'outcome'})

    def test_输出回显发布落点(self):
        self.assertEqual(W.build_output(self.RESULT, "draft")["mode"], "draft")


if __name__ == "__main__":
    unittest.main()
