"""本包自带的 ComfyUI 节点，由 scripts/comfyui.sh setup 软链接到 ComfyUI/custom_nodes/bcp。"""
from .image import BCPOpenAIImage
from .llm import BCPWeChatArticle
from .prompt import BCPBatchLines, BCPShotSpec, BCPSkill
from .text import BCPTitleOverlay
from . import config_api  # noqa: F401  注册 /bcp/config，供设置面板读写 .env

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {
    "bcp:shot_spec": BCPShotSpec,
    "bcp:skill": BCPSkill,
    "bcp:batch_lines": BCPBatchLines,
    "bcp:openai_image": BCPOpenAIImage,
    "bcp:title_overlay": BCPTitleOverlay,
    "bcp:wechat_article": BCPWeChatArticle,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "bcp:shot_spec": "拍摄规格 (BCP)",
    "bcp:skill": "技能 (BCP)",
    "bcp:batch_lines": "批量描述 (BCP)",
    "bcp:openai_image": "OpenAI Image (BCP)",
    "bcp:title_overlay": "中文标题 (BCP)",
    "bcp:wechat_article": "公众号文章 (BCP)",
}
