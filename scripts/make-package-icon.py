from pathlib import Path
from xml.etree import ElementTree as ET
from PIL import Image, ImageDraw
root=Path(__file__).resolve().parent.parent
svg=ET.parse(root/'app/build/icon.svg').getroot()
assert svg.get('viewBox')=='0 0 256 256'
image=Image.new('RGBA',(1024,1024));draw=ImageDraw.Draw(image)
for shape in svg:
    assert shape.tag.endswith('}rect'), 'Review rasterizer when SVG gains other shapes'
    x,y,w,h=[float(shape.get(k,'0'))*4 for k in ['x','y','width','height']]
    draw.rounded_rectangle((x,y,x+w,y+h),radius=float(shape.get('rx','0'))*4,fill=shape.get('fill'))
image.resize((256,256),Image.LANCZOS).save(root/'app/build/icon.png')
