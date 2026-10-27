"""Deterministic native-frame diagnostic media; no repeated frames or raw image sequences.
Python 3.7+, Pillow, NumPy and FFmpeg. Each frame is drawn at t=n/fps, then piped to H.264.
Run: python generate.py [--only ID ...] [--preview] [--validate-only]
Existing movies are never overwritten. No source clips, app settings or live rigs are modified.
"""
from pathlib import Path
import argparse, hashlib, json, math, shutil, subprocess, time
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parent
FFMPEG=shutil.which('ffmpeg'); FFPROBE=shutil.which('ffprobe')
SPECS=[('01-card-720p24',1280,720,24,10,'card'),('02-card-1080p24',1920,1080,24,10,'card'),
 ('03-card-1080p30',1920,1080,30,10,'card'),('04-card-1080p60',1920,1080,60,10,'card'),
 ('05-card-1440p30',2560,1440,30,8,'card'),('06-calm-texture-1080p30',1920,1080,30,30,'calm')]
FONT=Path('C:/Windows/Fonts/consola.ttf'); FONT_BOLD=Path('C:/Windows/Fonts/consolab.ttf')
RESAMPLE=Image.Resampling.BICUBIC
def sha(data):return hashlib.sha256(data).hexdigest()
def dump(name,value): (ROOT/name).write_bytes((json.dumps(value,indent=2)+'\n').encode())
def font(size,bold=False):return ImageFont.truetype(str(FONT_BOLD if bold else FONT),max(10,int(size)))

def texture(w,h):
 # Original deterministic continuous wave field, not corrupted or pre-glitched footage.
 y,x=np.mgrid[0:h,0:w].astype(np.float32);x/=w;y/=h
 field=(np.sin(14*x+2*np.sin(9*y))+.55*np.cos(23*y+4*x)+.28*np.sin(57*x+38*y)+.1*np.cos(151*x-92*y))/1.93
 field=(field+1)/2
 colours=np.array([[14,31,50],[43,100,112],[108,181,170],[227,181,117]],dtype=np.float32)
 at=np.clip(field*3,0,2.999);lo=at.astype(np.int32);mix=(at-lo)[...,None]
 rgb=colours[lo]*(1-mix)+colours[lo+1]*mix
 return Image.fromarray(np.uint8(np.clip(rgb,0,255)),'RGB')

class Card:
 def __init__(self,w,h,fps,duration,kind):
  self.w,self.h,self.fps,self.duration,self.kind=w,h,fps,duration,kind
  self.scale=w/1280;self.small=font(16*self.scale);self.medium=font(20*self.scale,True);self.big=font(28*self.scale,True)
  self.base=Image.new('RGB',(w,h),(12,17,23));d=ImageDraw.Draw(self.base)
  self.margin=round(w*.025);self.top=round(h*.14);self.bottom=round(h*.84)
  if kind=='calm':
   self.rects=[(self.margin,self.top,w-self.margin,self.bottom)]
  else:
   m=self.margin;gap=round(w*.015);mid=round(w*.53);ymid=round(h*.53)
   self.rects=[(m,self.top,mid-gap//2,ymid-gap//2),(mid+gap//2,self.top,w-m,ymid-gap//2),
               (m,ymid+gap//2,mid-gap//2,self.bottom),(mid+gap//2,ymid+gap//2,w-m,self.bottom)]
  x0,y0,x1,y1=self.rects[0];self.tw,self.th=x1-x0,y1-y0
  self.tex=texture(self.tw*2,self.th*2)
  for rect in self.rects:d.rectangle(rect,fill=(19,28,36),outline=(55,69,82),width=max(1,round(self.scale)))
  d.text((self.margin,round(h*.035)),'MOSHPIT  /  '+('CALM SOURCE' if kind=='calm' else 'NATIVE FRAME TEST'),font=self.big,fill=(230,239,239))
  label='{} x {}   /   {} fps   /   {} s'.format(w,h,fps,duration)
  d.text((self.margin,round(h*.088)),label,font=self.small,fill=(113,195,191))
  if kind=='card':self.make_static_detail()

 def make_static_detail(self):
  d=ImageDraw.Draw(self.base);x0,y0,x1,y1=self.rects[2]
  # Deliberately native 1/2/4/8 pixel features: compares decoding/scaling, not decorative upscaling.
  gap=round(10*self.scale);usable=(x1-x0-5*gap)//4;yy=y0+round(38*self.scale)
  for k,step in enumerate([1,2,4,8]):
   xx=x0+gap+(usable+gap)*k;hh=y1-yy-round(30*self.scale)
   a=np.indices((hh,usable)).sum(axis=0) if k==0 else np.indices((hh,usable))[1]
   tile=np.where((a//step)%2,214,37).astype(np.uint8);self.base.paste(Image.fromarray(tile,'L').convert('RGB'),(xx,yy))
   d.text((xx,y1-round(25*self.scale)),str(step)+' px',font=self.small,fill=(181,194,199))

 def frame(self,n):
  t=n/self.fps;im=self.base.copy();d=ImageDraw.Draw(im);s=self.scale
  x0,y0,x1,y1=self.rects[0]
  dx=self.tw*.30+self.tw*.020*t;dy=self.th*.28+self.th*.06*math.sin(t*.11)
  patch=self.tex.transform((self.tw,self.th),Image.Transform.AFFINE,(1,0,dx,0,1,dy),resample=RESAMPLE)
  im.paste(patch,(x0,y0));d=ImageDraw.Draw(im)
  if self.kind=='calm':
   d.text((x0+round(14*s),y0+round(12*s)),'SLOW CONTINUOUS DRIFT  /  NO EFFECTS BAKED IN',font=self.small,fill=(235,239,228),stroke_width=1,stroke_fill=(18,30,38))
  else:
   d.rectangle((x0,y0,x1,y0+round(32*s)),fill=(17,26,35))
   d.text((x0+round(10*s),y0+round(7*s)),'01  TEXTURE / VECTOR MOTION',font=self.small,fill=(141,207,201))
   # Floating-point gradient phase is independently recomputed for every native frame.
   a,b,c,e=self.rects[1];pw,ph=c-a,e-b
   xx=np.arange(pw,dtype=np.float32)[None,:]/pw;yy=np.arange(ph,dtype=np.float32)[:,None]/ph
   phase=2*math.pi*(xx*.8+yy*.18+t*.008)
   rgb=np.stack([np.broadcast_to(127.5+100*np.sin(phase+offset),(ph,pw)) for offset in [0,2.1,4.2]],axis=2).astype(np.uint8)
   im.paste(Image.fromarray(rgb,'RGB'),(a,b));d=ImageDraw.Draw(im)
   d.rectangle((a,b,c,b+round(32*s)),fill=(17,26,35));d.text((a+round(10*s),b+round(7*s)),'02  CHROMA / SMOOTH GRADIENT',font=self.small,fill=(141,207,201))
   a,b,c,e=self.rects[2];d.text((a+round(10*s),b+round(7*s)),'03  NATIVE PIXEL DETAIL',font=self.small,fill=(141,207,201))
   a,b,c,e=self.rects[3];d.text((a+round(10*s),b+round(7*s)),'04  EDGE / POSITION',font=self.small,fill=(141,207,201))
   for gx in range(a+round(15*s),c,round(40*s)):d.line((gx,b+round(38*s),gx,e-round(12*s)),fill=(39,52,64),width=1)
   cx=a+(c-a)*(.42+.20*math.sin(t*.18));cy=b+(e-b)*.59;r=(e-b)*.24
   d.ellipse((cx-r,cy-r,cx+r,cy+r),outline=(229,186,128),width=max(2,round(3*s)))
   angle=t*.22;tip=(cx+r*.93*math.cos(angle),cy+r*.93*math.sin(angle))
   d.line((cx,cy,*tip),fill=(230,239,239),width=max(2,round(3*s)))
   ex=a+(c-a)*(.82-.11*math.cos(t*.23))
   d.rectangle((ex,b+round(40*s),ex+round(6*s),e-round(14*s)),fill=(116,208,198))
  # Frame number changes on every frame; validation also excludes this footer.
  fy=round(self.h*.88)
  d.text((self.margin,fy),'FRAME {:05d} / {:05d}'.format(n,self.duration*self.fps-1),font=self.big,fill=(228,237,237))
  d.text((round(self.w*.51),fy),'t = {:07.3f} s'.format(t),font=self.big,fill=(128,208,201))
  bw=max(5,round(self.w*.010));bx=round(self.w*.80)
  for bit in range(12):d.rectangle((bx+bit*(bw+2),fy+round(5*s),bx+bit*(bw+2)+bw,fy+round(24*s)),fill=(222,226,216) if (n>>bit)&1 else (42,54,66))
  py=round(self.h*.953);d.rectangle((self.margin,py,self.w-self.margin,py+max(3,round(4*s))),fill=(39,54,63))
  d.rectangle((self.margin,py,self.margin+(self.w-2*self.margin)*(n+1)/(self.duration*self.fps),py+max(3,round(4*s))),fill=(91,198,187))
  return im

def frame_hashes(file,crop=None):
 args=[FFMPEG,'-v','error','-threads','2','-i',str(file),'-map','0:v:0','-an']
 if crop:args+=['-vf',crop]
 args+=['-pix_fmt','rgb24','-fps_mode','passthrough','-f','framemd5','-']
 out=subprocess.check_output(args).decode();rows=[line.split(',') for line in out.splitlines() if line and not line.startswith('#')]
 hashes=[r[-1].strip() for r in rows]
 return {'frames':len(hashes),'unique':len(set(hashes)),'adjacentDuplicates':sum(a==b for a,b in zip(hashes,hashes[1:])),'hashes':hashes}

def validate(spec):
 name,w,h,fps,duration,kind=spec;file=ROOT/(name+'.mp4')
 probe=json.loads(subprocess.check_output([FFPROBE,'-v','error','-select_streams','v:0','-count_frames','-show_streams','-show_frames','-show_entries','stream=width,height,avg_frame_rate,r_frame_rate,time_base,nb_read_frames,nb_frames,pix_fmt,color_space,color_range:frame=best_effort_timestamp_time,duration_time','-of','json',str(file)]))
 stream=probe['streams'][0];frames=probe['frames'];times=[float(f['best_effort_timestamp_time']) for f in frames]
 expected=fps*duration
 assert (stream['width'],stream['height'],int(stream['nb_read_frames']))==(w,h,expected)
 assert stream['r_frame_rate']==stream['avg_frame_rate']==str(fps)+'/1'
 assert len(times)==expected and abs(times[0])<1e-6
 error=max(abs(t-n/fps) for n,t in enumerate(times));assert error<1e-5
 full=frame_hashes(file);card=Card(w,h,fps,duration,kind);x0,y0,x1,y1=card.rects[0]
 crop='crop={}:{}:{}:{}'.format(x1-x0,y1-y0-round(40*card.scale),x0,y0+round(40*card.scale))
 motion=frame_hashes(file,crop)
 assert full['frames']==full['unique']==motion['frames']==motion['unique']==expected
 assert full['adjacentDuplicates']==motion['adjacentDuplicates']==0
 dump(name+'-decoded-hashes.json',{'full':full,'motionPanelExcludingCounters':motion,'crop':crop})
 return {'file':file.name,'bytes':file.stat().st_size,'sha256':sha(file.read_bytes()),'width':w,'height':h,'fps':fps,'seconds':duration,'decodedFrames':expected,'fullUniqueFrames':full['unique'],'motionUniqueFrames':motion['unique'],'duplicateFrames':0,'maxTimestampErrorSeconds':error,'probe':stream,'counterExcludedCrop':crop}

def render(spec):
 name,w,h,fps,duration,kind=spec;file=ROOT/(name+'.mp4');assert not file.exists(),'Refusing to overwrite '+str(file)
 card=Card(w,h,fps,duration,kind);card.frame(0).save(ROOT/(name+'-preview.png'))
 cmd=[FFMPEG,'-hide_banner','-v','error','-nostdin','-n','-f','rawvideo','-pix_fmt','rgb24','-s',str(w)+'x'+str(h),'-framerate',str(fps),'-i','pipe:0',
 '-an','-vf','scale=in_range=full:out_range=tv:out_color_matrix=bt709','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-threads','2','-g',str(fps*2),'-fps_mode','passthrough',
 '-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-movflags','+faststart',str(file)]
 with (ROOT/(name+'-encode.log')).open('wb') as log:
  proc=subprocess.Popen(cmd,stdin=subprocess.PIPE,stderr=log)
  try:
   for n in range(fps*duration):
    proc.stdin.write(card.frame(n).tobytes())
    if n%fps==0:print(name,'frame',n,'/',fps*duration,flush=True)
  finally:proc.stdin.close()
  if proc.wait()!=0:raise RuntimeError('FFmpeg failed; see '+str(log.name))

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--only',nargs='*',default=[]);parser.add_argument('--preview',action='store_true');parser.add_argument('--validate-only',action='store_true');args=parser.parse_args()
 specs=[s for s in SPECS if not args.only or s[0].split('-')[0] in args.only]
 manifest=ROOT/'manifest.json';records=json.loads(manifest.read_text()) if manifest.exists() else []
 for spec in specs:
  if args.preview:Card(*spec[1:]).frame(spec[3]*3).save(ROOT/(spec[0]+'-preview.png'));continue
  if not args.validate_only:render(spec)
  record=validate(spec);records=[r for r in records if r['file']!=record['file']]+[record];dump('manifest.json',records);print('VERIFIED',record['file'],record['decodedFrames'],'unique motion frames',flush=True)
 if not args.preview:
  thumbs=[]
  for spec in SPECS:
   preview=ROOT/(spec[0]+'-preview.png')
   if preview.exists():
    im=Image.open(preview).convert('RGB');im.thumbnail((640,360));thumbs.append(im)
  sheet=Image.new('RGB',(1280,360*math.ceil(len(thumbs)/2)),(12,17,23))
  for i,im in enumerate(thumbs):sheet.paste(im,((i%2)*640,(i//2)*360))
  sheet.save(ROOT/'contact-sheet.jpg',quality=90)
  dump('generation-info.json',{'generatorSHA256':sha(Path(__file__).read_bytes()),'python':'Python / Pillow / NumPy','ffmpeg':subprocess.check_output([FFMPEG,'-version']).decode().splitlines()[0],'ffmpegPath':FFMPEG,'font':str(FONT),'createdUTC':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'retiming':False,'sourceFrameEvaluation':'t=n/fps; native output dimensions; raw RGB piped directly; no image sequence saved','totalVideoBytes':sum(r['bytes'] for r in records)})
if __name__=='__main__':main()
