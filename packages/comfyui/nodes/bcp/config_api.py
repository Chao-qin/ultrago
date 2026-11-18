"""页面配置接口：设置面板（设置 → BCP）通过这里读写 packages/comfyui/.env。

key 只写不读：GET 只返回是否已配置和末 4 位。ComfyUI 自己的设置会被 /api/settings 原样返回给
任何能访问端口的人，所以设置面板不保存 key，填完就交给这里写进 .env。
"""
import os

from aiohttp import web
from dotenv import dotenv_values, set_key
from server import PromptServer

ENV_FILE = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", ".env")
FIELDS = {
    "image_base": "OPENAI_API_BASE",
    "image_key": "OPENAI_API_KEY",
    "text_base": "TEXT_API_BASE",
    "text_key": "TEXT_API_KEY",
    "text_model": "TEXT_MODEL",
}


def placeholder(value):
    """.env.example 里的占位值（your_key_here、https://your-base-url/v1 …）当作没填。"""
    return not value or "your_" in value or "your-" in value


def mask(value):
    return "未配置" if placeholder(value) else f"已配置（…{value[-4:]}）"


@PromptServer.instance.routes.get("/bcp/config")
async def get_config(request):
    env = dotenv_values(ENV_FILE)
    values = {k: env.get(v) or "" for k, v in FIELDS.items()}
    return web.json_response({k: mask(v) if k.endswith("_key") else ("" if placeholder(v) else v) for k, v in values.items()})


@PromptServer.instance.routes.post("/bcp/config")
async def set_config(request):
    data = await request.json()
    unknown = set(data) - set(FIELDS)
    if unknown:
        return web.json_response({"error": f"未知配置项：{', '.join(sorted(unknown))}"}, status=400)
    if not os.path.exists(ENV_FILE):
        open(ENV_FILE, "w").close()
    os.chmod(ENV_FILE, 0o600)
    for field, value in data.items():
        set_key(ENV_FILE, FIELDS[field], str(value).strip(), quote_mode="never")
    return web.json_response({"saved": sorted(data)})
