# 生成「本地群聊」账号与密钥 Word 文档
import os, json, datetime
from docx import Document
from docx.shared import Pt, RGBColor
from docx.oxml.ns import qn

ROOT = r"C:\Users\34288\.openclaw-autoclaw\workspace\group-chat"
TARGET_DIR = r"C:\Users\34288\Desktop\桌面图标\other\本地群聊"

def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read().strip()

admin_token = read(os.path.join(ROOT, "agents", ".admin.token"))
tokens = json.load(open(os.path.join(ROOT, "agents", ".tokens.local.json"), encoding="utf-8"))

doc = Document()

# 标题
h = doc.add_heading("本地群聊 · 账号与密钥", level=0)
p = doc.add_paragraph("生成时间：%s" % datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
p.runs[0].font.size = Pt(10)

doc.add_heading("一、服务信息", level=1)
for line in [
    ("访问地址", "http://127.0.0.1:8787"),
    ("讨论组", "%s（%s）" % (tokens.get("groupName", ""), tokens.get("groupId", ""))),
]:
    doc.add_paragraph("%s：%s" % line)

doc.add_heading("二、登录账号（群主 / 管理员）", level=1)
for line in [
    ("用户名", "app_owner"),
    ("密码", "app_owner_pass_123"),
    ("显示名", "讨论组管理员"),
    ("角色", "群主（owner），可改模型/改群名/移除成员/解散群/邀请成员"),
]:
    doc.add_paragraph("%s：%s" % line)

doc.add_heading("三、管理接口令牌（ADMIN_TOKEN）", level=1)
doc.add_paragraph("用于 /api/admin/* 台账与指标查询接口（HTTP 头 x-admin-token）：")
doc.add_paragraph(admin_token)

doc.add_heading("四、智能体令牌（Agent Token）", level=1)
doc.add_paragraph("用于各 Agent 桥接器入群（agents/.tokens.local.json，数据库仅存散列）：")
for key, name in [
    ("autoclaw", "AutoClaw"),
    ("hermes", "Hermes"),
    ("ekko", "Ekko Studio"),
    ("zcode", "ZCode"),
    ("demobrain", "本机演示大脑"),
]:
    t = tokens.get("tokens", {}).get(key, "")
    doc.add_paragraph("%s（%s）：%s" % (name, key, t))

doc.add_heading("五、使用说明", level=1)
for s in [
    "1. 双击桌面「群聊」快捷方式即可启动，或访问上面地址。",
    "2. 用「二、登录账号」登录，进入「多智能体讨论组（演示）」。",
    "3. 右上角「成员」面板里，每个 Agent 下方有模型下拉栏。",
    "4. 停止服务用桌面「群聊」文件夹里的「停止群聊.cmd」。",
]:
    doc.add_paragraph(s)

doc.add_heading("六、安全提醒", level=1)
for s in [
    "本文件含明文密钥，请妥善保管，勿外传、勿提交到代码仓库。",
    "登录密码为默认弱密码，正式使用前建议修改。",
]:
    doc.add_paragraph(s)

os.makedirs(TARGET_DIR, exist_ok=True)
out = os.path.join(TARGET_DIR, "本地群聊-账号与密钥.docx")
doc.save(out)
print("已生成:", out)
print("大小:", os.path.getsize(out), "bytes")
