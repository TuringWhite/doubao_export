from PIL import Image, ImageDraw, ImageFont

W, H = 440, 280
DARK = (20, 24, 33)
FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"

img = Image.new("RGB", (W, H), DARK)
d = ImageDraw.Draw(img)

for y in range(H):
    t = y / H
    d.line([(0, y), (W, y)],
           fill=(int(20 + 14 * (1 - t)), int(24 + 16 * (1 - t)), int(33 + 22 * (1 - t))))

icon = Image.open("/Users/baiweiyang/Workspace/doubao_export/icons/icon128.png").convert("RGBA")
icon = icon.resize((112, 112), Image.LANCZOS)
img.paste(icon, (36, 84), icon)

title_f = ImageFont.truetype(FONT, 32, index=2)   # W6 粗
sub_f   = ImageFont.truetype(FONT, 18, index=0)   # W3 常规
chip_f  = ImageFont.truetype(FONT, 13, index=0)

d.text((172, 72), "豆包对话导出器", font=title_f, fill=(255, 255, 255))
d.text((174, 122), "一键批量导出全部历史对话", font=sub_f, fill=(158, 174, 198))

chip_text = "Markdown · 本地处理 · 不上传"
tw = d.textlength(chip_text, font=chip_f)
d.rounded_rectangle((174, 164, 174 + tw + 32, 198), radius=17, fill=(36, 45, 62))
d.text((190, 173), chip_text, font=chip_f, fill=(140, 196, 255))

img.save("/Users/baiweiyang/Workspace/doubao_export/dist/promo-440x280.png")
print("promo rewritten")
