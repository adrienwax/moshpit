"""Verify native source motion independently of compression, then inspect decoded movies.
Does not render or modify MP4 files. Run after generate.py has completed.
"""
from pathlib import Path
import hashlib, io, json, math, subprocess
from PIL import Image, ImageDraw
from generate import ROOT, SPECS, Card, RESAMPLE, FFMPEG, font

records=[]
sheet=Image.new('RGB',(1280,3*400),(12,17,23))
draw=ImageDraw.Draw(sheet)
for i,spec in enumerate(SPECS):
 name,w,h,fps,duration,kind=spec
 card=Card(w,h,fps,duration,kind)
 hashes=[]
 for n in range(fps*duration):
  t=n/fps
  dx=card.tw*.30+card.tw*.020*t
  dy=card.th*.28+card.th*.06*math.sin(t*.11)
  patch=card.tex.transform((card.tw,card.th),Image.Transform.AFFINE,(1,0,dx,0,1,dy),resample=RESAMPLE)
  # Exactly the motion field below its label, excluding every counter and all other panels.
  crop=patch.crop((0,round(40*card.scale),card.tw,card.th))
  hashes.append(hashlib.sha256(crop.tobytes()).hexdigest())
 assert len(set(hashes))==fps*duration, name+' contains a repeated source motion sample'
 record={'file':name+'.mp4','sourceMotionFrames':len(hashes),'uniqueSourceMotionFrames':len(set(hashes)),
         'adjacentDuplicates':sum(a==b for a,b in zip(hashes,hashes[1:])), 'sha256':hashes}
 records.append(record)
 # One decoded sample at t=3s, so the contact sheet demonstrates the encoded deliverables.
 png=subprocess.check_output([FFMPEG,'-v','error','-ss','3','-i',str(ROOT/(name+'.mp4')),
  '-frames:v','1','-vf','scale=640:360','-f','image2pipe','-vcodec','png','-'])
 im=Image.open(io.BytesIO(png)).convert('RGB')
 x,y=(i%2)*640,(i//2)*400
 sheet.paste(im,(x,y));draw.text((x+12,y+368),name+'  /  decoded 3s',font=font(16),fill=(184,208,209))
 print('SOURCE VERIFIED',name,len(hashes),flush=True)
(ROOT/'source-motion-hashes.json').write_text(json.dumps(records,indent=2)+'\n',encoding='utf-8')
sheet.save(ROOT/'decoded-contact-sheet.jpg',quality=93)
print('PASS: source motion uniqueness + decoded contact sheet',flush=True)
