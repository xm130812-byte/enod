from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
accent = (180, 85, 45, 255)
paper = (255, 249, 242, 255)
shadow = (196, 122, 86, 255)

# 透明底：一本打开的书，缩到 16px 仍能看出轮廓
left = [(150, 300), (500, 240), (500, 790), (150, 720)]
right = [(874, 300), (524, 240), (524, 790), (874, 720)]
d.polygon(left, fill=paper, outline=accent, width=22)
d.polygon(right, fill=paper, outline=accent, width=22)
d.polygon([(500, 240), (524, 240), (524, 790), (500, 790)], fill=shadow)
for y in range(340, 700, 64):
    d.line([(210, y), (454, y - 22)], fill=accent, width=16)
    d.line([(570, y - 22), (814, y)], fill=accent, width=16)
# 书签
d.polygon([(720, 240), (800, 240), (800, 430), (760, 390), (720, 430)], fill=(47, 125, 110, 255))

for size, name in [(64, "tray-64.png"), (32, "tray-32.png"), (256, "tray-256.png")]:
    out = img.resize((size, size), Image.LANCZOS)
    out.save(rf"D:\something\md-reader\packages\shell\src-tauri\icons\{name}")
print("tray icons written")
