import json
import unittest
from pathlib import Path

from preprocess import build_attribute_candidates, build_images, build_sku_properties, build_sku_table


class CanonicalContractTests(unittest.TestCase):
    def test_canonical_schema_pins_image_and_sku_keys(self):
        """schema 必须钉死图片分组与 SKU 行的键名。

        原版钉的是 final.schema.json —— 那个过渡产物连同它的 skuTable 形状已经
        删掉了（run_pipeline 里写明「等下游都改读 canonical 之后删掉」），所以这
        条测试一直在 FileNotFoundError 上红着，等于没有防线。这里把它改钉到现行
        的 canonical.schema.json 上：意图不变（键名被契约锁住），锚点换成还活着
        的那份，并顺带锁住 main 的 1..5 张硬约束。
        """
        schema = json.loads((Path(__file__).parent / "canonical.schema.json").read_text(encoding="utf-8"))
        images = schema["properties"]["images"]
        self.assertEqual(images["required"], ["main", "detail"])
        self.assertEqual(images["properties"]["main"]["minItems"], 1)
        self.assertEqual(images["properties"]["main"]["maxItems"], 5)
        self.assertEqual(schema["properties"]["skus"]["items"]["required"], ["specs", "price", "stock"])

    def test_uses_english_structure_keys_and_preserves_source_labels_as_values(self):
        data = {
            "CommodityImage": {"ConfigList": [{"Label": "主图", "List": ["https://example.com/main.jpg"]}]},
            "DetailImage": {"ConfigList": [{"Label": "详情图", "List": ["https://example.com/detail.jpg"]}]},
            "BaseInfo": {"Attr": {"SourceAttr": [{"Label": "材质", "Value": "塑胶,树脂"}]}},
            "PriceAndStock": {
                "Skus": [{
                    "SkuSpec": [{"PropertyName": "颜色", "ValueName": "红色"}],
                    "Price": 9.9,
                    "Quantity": 12,
                    "OuterID": "sku-red",
                }],
                "SkuProperties": [{
                    "PropertyName": "颜色",
                    "Values": [{"ValueName": "红色", "ImgUrl": "https://example.com/red.jpg"}],
                }],
            },
        }

        self.assertEqual(build_images(data), {
            "main": ["https://example.com/main.jpg"],
            "detail": ["https://example.com/detail.jpg"],
        })
        self.assertEqual(build_attribute_candidates(data), [{
            "sourceName": "材质", "rawValue": "塑胶,树脂", "values": ["塑胶", "树脂"],
        }])
        self.assertEqual(build_sku_table(data), {
            "columns": ["specs", "sourcePrice", "stock", "merchantCode"],
            "rows": [{
                "specs": [{"sourceName": "颜色", "value": "红色"}],
                "sourcePrice": 9.9,
                "stock": 12,
                "merchantCode": "sku-red",
            }],
        })
        self.assertEqual(build_sku_properties(data), [{
            "sourceName": "颜色",
            "values": [{"value": "红色", "imageUrl": "https://example.com/red.jpg"}],
        }])


if __name__ == "__main__":
    unittest.main()
