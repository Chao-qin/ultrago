"""生成 packages/comfyui/workflows/ 下的工作流（ComfyUI 界面格式）。

节点参数改了（增删 widget、调整顺序）就重新跑一次：
  python3 scripts/gen_workflows.py            # 全部
  python3 scripts/gen_workflows.py ecommerce  # 指定几个
setup 只补缺、不覆盖界面里改过的同名工作流。

可选功能放在标题以「可选：」开头的分组里，由 rgthree 的分组开关节点一键开关；
默认关闭的分组，组内节点生成时就是绕过状态（mode 4）。
"""
import json
import os
import sys
import uuid

PKG_DIR = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..")
OUT = os.path.join(PKG_DIR, "workflows")
SEED = [0, "randomize"]  # 种子值 + 前端自动加的「运行后随机换值」控件
OPTIONAL = "可选："
BYPASS = 4
with open(os.path.join(PKG_DIR, "prompt_library.json"), encoding="utf-8") as f:
    DIMENSIONS = list(json.load(f)["dimensions"])


class WF:
    def __init__(self):
        self.nodes, self.links, self.groups = {}, [], []

    def add(self, nid, type_, pos, size, widgets, inputs=(), outputs=(), title=None, mode=0, properties=None):
        n = {"id": nid, "type": type_, "pos": pos, "size": size, "flags": {}, "order": len(self.nodes), "mode": mode,
             "inputs": [dict(i, link=None) for i in inputs],
             "outputs": [{"name": o, "type": t, "links": []} for o, t in outputs],
             "properties": properties or {"Node name for S&R": type_}, "widgets_values": widgets}
        if title:
            n["title"] = title
        self.nodes[nid] = n
        return nid

    def link(self, src, sslot, dst, dname):
        lid = len(self.links) + 1
        dn = self.nodes[dst]
        dslot = next(i for i, inp in enumerate(dn["inputs"]) if inp["name"] == dname)
        typ = dn["inputs"][dslot]["type"]
        dn["inputs"][dslot]["link"] = lid
        self.nodes[src]["outputs"][sslot]["links"].append(lid)
        self.links.append([lid, src, sslot, dst, dslot, typ])

    def group(self, title, ids, enabled=True, color="#3f789e"):
        """把节点框进一个分组；默认关闭的可选分组把组内节点设成绕过。"""
        xs = [self.nodes[i]["pos"][0] for i in ids]
        ys = [self.nodes[i]["pos"][1] for i in ids]
        x2 = [self.nodes[i]["pos"][0] + self.nodes[i]["size"][0] for i in ids]
        y2 = [self.nodes[i]["pos"][1] + self.nodes[i]["size"][1] for i in ids]
        x, y = min(xs) - 20, min(ys) - 60
        self.groups.append({"id": len(self.groups) + 1, "title": title, "bounding": [x, y, max(x2) + 20 - x, max(y2) + 20 - y],
                            "color": color, "font_size": 24, "flags": {}})
        if not enabled:
            for i in ids:
                self.nodes[i]["mode"] = BYPASS

    # ---- 节点 ----
    def switches(self, nid, pos):
        """rgthree 分组开关：只列出「可选：」开头的分组。"""
        return self.add(nid, "Fast Groups Bypasser (rgthree)", pos, [460, 200], [], outputs=[("OPT_CONNECTION", "*")],
                        title="开关：可选功能",
                        properties={"matchColors": "", "matchTitle": OPTIONAL, "showNav": True, "sort": "position",
                                    "customSortAlphabet": "", "toggleRestriction": "default"})

    def load_image(self, nid, pos, title):
        return self.add(nid, "LoadImage", pos, [300, 360], ["example.png", "image"],
                        outputs=[("IMAGE", "IMAGE"), ("MASK", "MASK")], title=title)

    def load_output(self, nid, pos, title):
        return self.add(nid, "LoadImageOutput", pos, [300, 360], [""], outputs=[("IMAGE", "IMAGE"), ("MASK", "MASK")], title=title)

    def text(self, nid, pos, title, value):
        return self.add(nid, "PrimitiveStringMultiline", pos, [340, 160], [value], outputs=[("STRING", "STRING")], title=title)

    def batch(self, nid, pos, value):
        return self.add(nid, "bcp:batch_lines", pos, [340, 200], [value], outputs=[("lines", "STRING")], title="批量描述（每行一张）")

    def spec(self, nid, pos, title="拍摄规格", extra="", **picked):
        widgets = [picked.get(d, "默认") for d in DIMENSIONS] + [extra]
        return self.add(nid, "bcp:shot_spec", pos, [340, 330], widgets, outputs=[("spec", "STRING")], title=title)

    def skill(self, nid, pos, skill, input_text="", refs_note="", title=None, linked_input=False):
        inputs = [{"name": "spec", "type": "STRING"}, {"name": "batch", "type": "STRING"}]
        if linked_input:
            inputs.append({"name": "input", "type": "STRING", "widget": {"name": "input"}})
        return self.add(nid, "bcp:skill", pos, [340, 300], [skill, input_text, refs_note, ""], inputs=inputs,
                        outputs=[("prompt", "STRING"), ("size", "STRING"), ("skill", "STRING")], title=title)

    def image(self, nid, pos, title=None, prompt="", size="auto", quality="medium", n=1, background="auto", linked=("prompt", "size")):
        inputs = [{"name": f"image_{i}", "shape": 7, "type": "IMAGE"} for i in range(1, 9)]
        inputs.append({"name": "mask", "shape": 7, "type": "MASK"})
        inputs += [{"name": w, "type": "STRING", "widget": {"name": w}} for w in linked]
        return self.add(nid, "bcp:openai_image", pos, [380, 440], ["gpt-image-2.5", prompt, size, quality, n, background, *SEED],
                        inputs=inputs, outputs=[("images", "IMAGE"), ("alpha", "MASK")], title=title)

    def scale(self, nid, pos, w, h, title):
        return self.add(nid, "ImageScale", pos, [300, 180], ["lanczos", w, h, "center"],
                        inputs=[{"name": "image", "type": "IMAGE"}], outputs=[("IMAGE", "IMAGE")], title=title)

    def stitch(self, nid, pos, direction, title):
        return self.add(nid, "ImageStitch", pos, [270, 160], [direction, True, 16, "white"],
                        inputs=[{"name": "image1", "type": "IMAGE"}, {"name": "image2", "shape": 7, "type": "IMAGE"}],
                        outputs=[("IMAGE", "IMAGE")], title=title)

    def title_overlay(self, nid, pos, text, linked_text=False):
        inputs = [{"name": "images", "type": "IMAGE"}]
        if linked_text:
            inputs.append({"name": "text", "type": "STRING", "widget": {"name": "text"}})
        return self.add(nid, "bcp:title_overlay", pos, [320, 260], [text, 8.0, "#ffffff", "top", True],
                        inputs=inputs, outputs=[("images", "IMAGE")], title="中文标题")

    def pad_outpaint(self, nid, pos):
        return self.add(nid, "ImagePadForOutpaint", pos, [300, 220], [0, 0, 512, 0, 40],
                        inputs=[{"name": "image", "type": "IMAGE"}], outputs=[("IMAGE", "IMAGE"), ("MASK", "MASK")], title="扩展画布")

    def join_alpha(self, nid, pos):
        return self.add(nid, "JoinImageWithAlpha", pos, [260, 80], [],
                        inputs=[{"name": "image", "type": "IMAGE"}, {"name": "alpha", "type": "MASK"}],
                        outputs=[("IMAGE", "IMAGE")], title="合成透明度")

    def rmbg(self, nid, pos, background, title):
        return self.add(nid, "RMBG", pos, [340, 400], ["RMBG-2.0", 1.0, 1024, 0, 0, False, True, False, background, "#ffffff"],
                        inputs=[{"name": "image", "type": "IMAGE"}],
                        outputs=[("IMAGE", "IMAGE"), ("MASK", "MASK"), ("MASK_IMAGE", "IMAGE")], title=title)

    def upscale(self, nid, pos):
        self.add(nid, "UpscaleModelLoader", [pos[0], pos[1] + 120], [300, 80], ["RealESRGAN_x2plus.pth"],
                 outputs=[("UPSCALE_MODEL", "UPSCALE_MODEL")])
        u = self.add(nid + 1, "ImageUpscaleWithModel", pos, [300, 80], [],
                     inputs=[{"name": "upscale_model", "type": "UPSCALE_MODEL"}, {"name": "image", "type": "IMAGE"}],
                     outputs=[("IMAGE", "IMAGE")], title="2 倍放大")
        self.link(nid, 0, u, "upscale_model")
        return u

    def article(self, nid, pos, topic):
        return self.add(nid, "bcp:wechat_article", pos, [360, 340], [topic, "专业、亲切、口语化", 1500, 3, *SEED, ""],
                        outputs=[("title", "STRING"), ("article", "STRING"), ("cover", "STRING"), ("images", "STRING")])

    def save(self, nid, pos, prefix, title=None):
        return self.add(nid, "SaveImage", pos, [340, 400], [prefix], inputs=[{"name": "images", "type": "IMAGE"}], title=title)

    def save_text(self, nid, pos, prefix):
        return self.add(nid, "SaveText", pos, [300, 120], [prefix, "md"], inputs=[{"name": "text", "type": "STRING"}])

    def preview(self, nid, pos, title):
        return self.add(nid, "PreviewImage", pos, [480, 400], [], inputs=[{"name": "images", "type": "IMAGE"}], title=title)

    def show(self, nid, pos, title):
        return self.add(nid, "PreviewAny", pos, [380, 220], [], inputs=[{"name": "source", "type": "*"}], title=title)

    def note(self, nid, pos, text, size=(340, 360)):
        return self.add(nid, "Note", pos, list(size), [text], title="使用说明")

    def skill_to_image(self, s, img):
        self.link(s, 0, img, "prompt")
        self.link(s, 1, img, "size")

    def dump(self, name):
        wf = {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, name)), "revision": 0,
              "last_node_id": max(self.nodes), "last_link_id": len(self.links),
              "nodes": list(self.nodes.values()), "links": self.links, "groups": self.groups, "config": {},
              "extra": {"ds": {"scale": 0.6, "offset": [200, 460]}}, "version": 0.4}
        with open(os.path.join(OUT, f"{name}.json"), "w", encoding="utf-8") as f:
            json.dump(wf, f, ensure_ascii=False, indent=2)


def grid(w, base, pos, sources, cols):
    """按行拼接成总览：每行横向拼 cols 张，再把各行纵向拼起来。返回最后一个拼接节点。"""
    x, y = pos
    nid, rows = base, []
    for r in range(0, len(sources), cols):
        row = sources[r]
        for i, src in enumerate(sources[r + 1:r + cols]):
            st = w.stitch(nid, [x + i * 290, y + len(rows) * 200], "right", f"拼接：第 {len(rows) + 1} 行")
            w.link(row, 0, st, "image1")
            w.link(src, 0, st, "image2")
            row, nid = st, nid + 1
        rows.append(row)
    out = rows[0]
    for i, row in enumerate(rows[1:], 1):
        st = w.stitch(nid, [x + cols * 290, y + i * 200], "down", "拼接：总览")
        w.link(out, 0, st, "image1")
        w.link(row, 0, st, "image2")
        out, nid = st, nid + 1
    return out


def generate():
    w = WF()
    sw = w.switches(1, [0, -220])
    refs = [w.load_image(2, [0, 0], "参考图 1"), w.load_image(3, [0, 400], "参考图 2")]
    w.group(OPTIONAL + "参考图", refs, enabled=False)
    lines = w.batch(4, [0, 860], "一座漂浮在云海上的小岛，岛上有一座灯塔，夜晚满天星空\n樱花树下的小猫，春日午后")
    w.group(OPTIONAL + "批量描述", [lines], enabled=False)
    s = w.skill(10, [380, 0], "自由生图", "在这里写画面描述", "", title="技能")
    sp = w.spec(11, [380, 340])
    g = w.image(20, [760, 0], "出图")
    j = w.join_alpha(21, [760, 480])
    w.link(sp, 0, s, "spec")
    w.link(lines, 0, s, "batch")
    for slot, ref in enumerate(refs, 1):
        w.link(ref, 0, g, f"image_{slot}")
    w.skill_to_image(s, g)
    w.link(g, 0, j, "image")
    w.link(g, 1, j, "alpha")
    w.link(j, 0, w.save(30, [1180, 0], "出图/图"), "images")
    w.link(s, 2, w.show(31, [380, 720], "实际使用的技能"), "source")
    w.link(s, 0, w.show(32, [760, 620], "最终提示词"), "source")
    w.note(5, [1180, 460], "一个工作流覆盖文生图、参考图、批量、AI 选技能、透明底：\n"
                          "1. 技能：下拉选用途；选「AI 自动选择」由文本模型挑技能并扩写描述（要先在 设置 → BCP 配文本模型）。\n"
                          "2. 拍摄规格：每个维度「默认」= 用技能的预设；选了别的就覆盖这一项。最终提示词在下方显示。\n"
                          "3. 左上「开关」：打开「参考图」上传最多 2 张参考（会走改图接口）；打开「批量描述」每行出一张。\n"
                          "4. 出图节点 background 选 transparent 就保存透明 PNG；quality 先用 low 试，满意再调高。\n"
                          "5. 每次 Run 都重新出图；想复用上次结果把 seed 下面的控制改成 fixed。")
    w.dump("出图")


def ecommerce():
    w = WF()
    w.switches(1, [0, -220])
    front = w.load_image(2, [0, 0], "参考图：产品正面（必填）")
    extra = [w.load_image(3, [0, 420], "参考图：其他角度"), w.load_image(4, [0, 840], "参考图：细节")]
    w.group(OPTIONAL + "更多参考图", extra, enabled=False)
    info = w.text(5, [0, 1320], "产品信息（6 张共用）", "产品：在这里写产品名称\n主推颜色：在这里写主推的颜色款\n卖点1：……\n卖点2：……\n卖点3：……")
    sp = w.spec(6, [0, 1540], "统一风格（6 张共用）")
    shots = [("01 白底主图", "白底主图"), ("02 多色合集", "多色合集"), ("03 卖点1特写", "卖点特写"),
             ("04 卖点2细节", "细节展示"), ("05 生活场景", "生活场景"), ("06 模特使用", "模特使用")]
    resized, main = [], None
    for i, (shot, skill) in enumerate(shots):
        y = i * 500
        refs_note = ("图 1 是产品正面，其余是产品的其他角度或细节" if main is None else
                     "图 1 是第 1 张主图，色调和光线风格与它保持一致；图 2 是产品正面，其余是产品的其他角度或细节")
        s = w.skill(10 + i, [380, y], skill, refs_note=refs_note, title=f"技能：{shot}", linked_input=True)
        g = w.image(20 + i, [760, y], title=f"出图：{shot}")
        r = w.scale(40 + i, [1160, y + 160], 800, 800, "800x800")
        w.link(info, 0, s, "input")
        w.link(sp, 0, s, "spec")
        for slot, src in enumerate(([] if main is None else [main]) + [front, *extra], 1):
            w.link(src, 0, g, f"image_{slot}")
        w.skill_to_image(s, g)
        name = shot.replace(" ", "_")
        o1 = w.save(30 + i, [1500, y], f"电商主图/原图/{name}", title=f"原图：{shot}")
        o2 = w.save(50 + i, [1860, y], f"电商主图/800x800/{name}", title=f"800x800：{shot}")
        w.link(g, 0, o1, "images")
        w.link(g, 0, r, "image")
        w.link(r, 0, o2, "images")
        if main is not None:  # 01 是后面几张的风格基准，不能关
            w.group(f"{OPTIONAL}{shot}", [s, g, r, o1, o2], enabled=True, color="#8a5a00")
        resized.append(r)
        main = main or g
    overview = grid(w, 60, [2260, 0], resized, cols=3)
    w.link(overview, 0, w.preview(70, [2260, 460], "6 张总览（不保存）"), "images")
    w.note(7, [0, 1920], "1. 「产品正面」上传清晰的产品照片；有其他角度、细节图就在「开关」里打开「更多参考图」。\n"
                         "2. 「产品信息」按格式写：主推颜色决定主角是哪一款；卖点1/2/3 分别对应第 3、4、5 张。\n"
                         "3. 「统一风格」只改要 6 张统一的维度（通常是色调、风格）；机位、镜头、景深由每张的技能各自预设。\n"
                         "4. 先出 01 白底主图，后面几张把它当图 1 来统一色调和光线；全部 1:1。\n"
                         "5. 不要某一张：在「开关」里关掉它（01 是风格基准，不能关）。\n"
                         "6. 文件名带 01~06 序号，存在 output/电商主图/原图/ 和 800x800/。\n\n"
                         "注意：每次 Run 最多调用 6 次接口；先用 low 画质试方案。", size=(340, 420))
    w.dump("电商主图套图")


def note_set():
    w = WF()
    w.switches(1, [0, -220])
    subject = w.load_image(2, [0, 0], "主体（产品或人物）")
    sp = w.spec(3, [0, 420], "统一风格（4 页共用）")
    cs = w.skill(10, [380, 0], "笔记封面", "标题：夏天必备的 3 个降温好物", "图 1 是主体", title="技能：封面")
    cg = w.image(20, [760, 0], title="出图：封面")
    ct = w.title_overlay(40, [1160, 0], "夏天必备的 3 个降温好物")
    w.group(OPTIONAL + "封面叠加中文标题", [ct], enabled=False)
    w.link(sp, 0, cs, "spec")
    w.link(subject, 0, cg, "image_1")
    w.skill_to_image(cs, cg)
    w.link(cg, 0, ct, "images")
    w.link(ct, 0, w.save(30, [1520, 0], "图文笔记/01_封面"), "images")
    outs = [ct]
    pages = ["第 1 页：好物一，写清楚它是什么、解决什么问题", "第 2 页：好物二，展示使用场景", "第 3 页：好物三，总结推荐理由"]
    for i, text in enumerate(pages, start=1):
        y = i * 500
        s = w.skill(10 + i, [380, y], "笔记内页", text, "图 1 是主体，图 2 是封面", title=f"技能：内页 {i}")
        g = w.image(20 + i, [760, y], title=f"出图：内页 {i}")
        w.link(sp, 0, s, "spec")
        w.link(subject, 0, g, "image_1")
        w.link(cg, 0, g, "image_2")
        w.skill_to_image(s, g)
        w.link(g, 0, w.save(30 + i, [1520, y], f"图文笔记/{i + 1:02d}_内页{i}"), "images")
        outs.append(g)
    overview = grid(w, 50, [1900, 0], outs, cols=4)
    w.link(overview, 0, w.preview(60, [1900, 300], "4 页预览（不保存）"), "images")
    w.note(4, [0, 820], "1. 「主体」上传产品或人物图；封面写标题，3 个内页各写一页内容。\n"
                        "2. 先出封面，内页把封面当参考图 2，配色和版式跟着封面走；全部 3:4 竖图。\n"
                        "3. 标题有错字：封面技能改成「笔记封面（留白）」，再在「开关」里打开「封面叠加中文标题」，字由节点叠加，一定对。\n"
                        "4. 存在 output/图文笔记/，文件名带页码。\n\n注意：每次 Run 调用 4 次接口；内页要等封面出完。")
    w.dump("图文笔记套图")


def wechat():
    w = WF()
    w.switches(1, [400, -220])
    art = w.article(2, [0, 0], "主题：在这里写文章主题\n要点：\n1. ……\n2. ……\n3. ……")
    w.link(art, 1, w.save_text(3, [0, 380], "公众号/文章"), "text")
    w.link(art, 1, w.show(4, [0, 540], "文章预览"), "source")
    sp = w.spec(5, [0, 800], "统一风格（封面和配图共用）")
    cs = w.skill(10, [400, 0], "公众号封面", title="技能：封面", linked_input=True)
    cg = w.image(20, [780, 0], "出图：封面")
    w.link(art, 2, cs, "input")
    w.link(sp, 0, cs, "spec")
    w.skill_to_image(cs, cg)
    head = w.scale(30, [1200, 0], 900, 383, "首图 900x383")
    t = w.title_overlay(31, [1200, 220], "", linked_text=True)
    w.group(OPTIONAL + "首图叠加文章标题", [t], enabled=False)
    w.link(cg, 0, head, "image")
    w.link(head, 0, t, "images")
    w.link(art, 0, t, "text")
    w.link(t, 0, w.save(32, [1560, 0], "公众号/首图"), "images")
    sub = w.scale(33, [1200, 540], 200, 200, "次图 200x200（取首图中间）")
    w.link(cg, 0, sub, "image")
    w.link(sub, 0, w.save(34, [1560, 440], "公众号/次图"), "images")
    ps = w.skill(11, [400, 480], "公众号配图", refs_note="参考图是文章封面，色调和画面风格与它统一", title="技能：配图（每条描述各出一张）", linked_input=True)
    pg = w.image(21, [780, 480], "出图：正文配图")
    w.link(art, 3, ps, "input")
    w.link(sp, 0, ps, "spec")
    w.link(cg, 0, pg, "image_1")
    w.skill_to_image(ps, pg)
    w.link(pg, 0, w.save(35, [1560, 880], "公众号/配图"), "images")
    w.note(6, [400, 980], "1. 在「公众号文章」里写主题和要点，调口吻、字数、配图张数（要先在 设置 → BCP 配文本模型）。\n"
                          "2. 文本模型写出标题、Markdown 正文（带【配图1】等占位）、封面和每张配图的画面描述。\n"
                          "3. 封面裁成首图 900x383 和次图 200x200；正文配图参考封面统一风格，按顺序对应【配图N】。\n"
                          "4. 首图要叠标题：在「开关」里打开，标题自动取文章标题。\n"
                          "5. 全部存在 output/公众号/。\n\n注意：每次 Run 调用 1 次文本模型 + (1 + 配图张数) 次出图。")
    w.dump("公众号文章套图")


def edit():
    w = WF()
    w.switches(1, [0, -220])
    src = w.load_image(2, [0, 0], "原图（局部重绘：右键 → Open in MaskEditor 涂要改的地方）")
    g = w.image(10, [380, 0], "局部重绘", prompt="把涂抹区域改成：", linked=())
    o = w.save(11, [800, 0], "图片编辑/局部重绘")
    cmp_ = w.stitch(12, [800, 440], "right", "拼接：改前 | 改后")
    pv = w.preview(13, [1180, 0], "改前改后对比（不保存）")
    w.link(src, 0, g, "image_1")
    w.link(src, 1, g, "mask")
    w.link(g, 0, o, "images")
    w.link(src, 0, cmp_, "image1")
    w.link(g, 0, cmp_, "image2")
    w.link(cmp_, 0, pv, "images")
    w.group(OPTIONAL + "局部重绘", [g, o, cmp_, pv], enabled=True)
    pad = w.pad_outpaint(20, [380, 760])
    g2 = w.image(21, [720, 760], "扩图", prompt="向外延伸画面，补全周围的场景，风格、光线和原图保持一致", linked=())
    o2 = w.save(22, [1140, 760], "图片编辑/扩图")
    w.link(src, 0, pad, "image")
    w.link(pad, 0, g2, "image_1")
    w.link(pad, 1, g2, "mask")
    w.link(g2, 0, o2, "images")
    w.group(OPTIONAL + "扩图", [pad, g2, o2], enabled=False)
    w.note(3, [0, 420], "1. 「原图」上传图片，在「开关」里选要做局部重绘还是扩图（两个都开就一次做两件事）。\n"
                        "2. 局部重绘：右键原图 → Open in MaskEditor 涂出要改的区域 → Save，再在 prompt 里写改成什么。没涂蒙版时整张都不会被当成可修改区域。\n"
                        "3. 扩图：在「扩展画布」里填四个方向各扩多少像素；扩完的宽高比要在 1:3 到 3:1 之间。\n\n"
                        "注意：每个打开的功能调用 1 次接口。")
    w.dump("图片编辑")


def local_tools():
    w = WF()
    w.switches(1, [0, -220])
    src = w.load_image(2, [0, 0], "产品图（抠图）")
    white = w.rmbg(3, [380, 0], "Color", "抠图：白底")
    clear = w.rmbg(4, [380, 440], "Alpha", "抠图：透明")
    r = w.scale(5, [760, 0], 800, 800, "800x800")
    o1, o2 = w.save(6, [1100, 0], "本地后期/白底800"), w.save(7, [760, 440], "本地后期/透明")
    w.link(src, 0, white, "image")
    w.link(src, 0, clear, "image")
    w.link(white, 0, r, "image")
    w.link(r, 0, o1, "images")
    w.link(clear, 0, o2, "images")
    w.group(OPTIONAL + "抠图", [src, white, clear, r, o1, o2], enabled=True)
    pick = w.load_output(10, [0, 980], "选一张已生成的图（output 目录）")
    u = w.upscale(11, [380, 980])
    o3 = w.save(13, [760, 980], "本地后期/放大")
    w.link(pick, 0, u, "image")
    w.link(u, 0, o3, "images")
    w.group(OPTIONAL + "高清放大", [pick, u, u - 1, o3], enabled=False)
    w.note(8, [1100, 460], "全部在本机 CPU 上运行，不调接口、不花钱。在「开关」里选要用的功能。\n"
                           "1. 抠图（RMBG-2.0）：出 800x800 白底图和透明 PNG；第一次运行下载约 845MB 模型，之后每张约 6 秒。边缘有残色调 sensitivity / mask_offset。RMBG-2.0 是自定义许可，商用前确认 BRIA 的条款。\n"
                           "2. 高清放大（RealESRGAN 2 倍）：从 output 目录选一张图，1536 → 3072 约 15 秒。")
    w.dump("本地后期")


ALL = {f.__name__: f for f in (generate, ecommerce, note_set, wechat, edit, local_tools)}
os.makedirs(OUT, exist_ok=True)
for name in sys.argv[1:] or ALL:
    ALL[name]()
print("ok")
