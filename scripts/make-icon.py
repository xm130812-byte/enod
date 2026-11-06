from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# 暖纸底色（与前端 favicon 一致）
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=220, fill=(180, 85, 45, 255))
# 打开的书：两页
left = [(190, 300), (500, 250), (500, 760), (190, 700)]
right = [(834, 300), (524, 250), (524, 760), (834, 700)]
d.polygon(left, fill=(255, 246, 239, 255))
d.polygon(right, fill=(255, 250, 244, 255))
# 书脊阴影
d.polygon([(500, 250), (524, 250), (524, 760), (500, 760)], fill=(232, 210, 196, 255))
# 行
for i, y in enumerate(range(360, 680, 62)):
    d.line([(250, y - 20), (450, y - 40)], fill=(180, 85, 45, 210), width=16)
    d.line([(574, y - 40), (774, y - 20)], fill=(180, 85, 45, 210), width=16)
# 强调色书签
d.polygon([(720, 250), (800, 250), (800, 430), (760, 390), (720, 430)], fill=(47, 125, 110, 255))
img.save(r"D:\something\md-reader\packages\shell\src-tauri\icon-source.png")
print("wrote icon-source.png")
