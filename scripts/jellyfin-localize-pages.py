from pathlib import Path
import json,re,html,sys
root=Path(sys.argv[1])
mapping=json.loads((Path(__file__).resolve().parent.parent/'resources/jellyfin-plugins/localization/zh-CN.json').read_text(encoding='utf-8'))
for p in root.glob('*/resources/*.html'):
 s=p.read_text(encoding='utf-8-sig')
 # Preserve scripts, styles and the example SQL textarea verbatim.
 parts=re.split(r'(<(?:script|style|textarea)\b[^>]*>.*?</(?:script|style|textarea)>)',s,flags=re.S|re.I)
 def node(match):
  value=html.unescape(match[1]).strip()
  replacement=mapping.get(value)
  return '>'+match[1].replace(value,replacement)+'<' if replacement else match[0]
 for i in range(0,len(parts),2):parts[i]=re.sub(r'>([^<>]+)<',node,parts[i])
 target=p.parent.parent/'translated';target.mkdir(exist_ok=True)
 (target/p.name).write_text(''.join(parts),encoding='utf-8')
 remaining=set()
 for i in range(0,len(parts),2):
  for value in re.findall(r'>([^<>]+)<',parts[i]):
   value=html.unescape(value).strip()
   if re.search('[a-zA-Z]',value) and not re.search('[\u4e00-\u9fff]',value) and value not in ['info','close','drag_indicator','embedded','main','latest','Jellyseerr','LibreTranslate','DD/MM','DD/MM/YYYY','MM/DD','MM/DD/YYYY','YYYY/MM/DD','${Save}','${ButtonLearnMore}']:remaining.add(value)
 if remaining: print(p.name,sorted(remaining))

for p in root.glob('*/resources/*.js'):
 if p.name.endswith('.min.js'):continue
 s=p.read_text(encoding='utf-8-sig')
 def literal(match):
  prefix,quote,value=match.groups()
  text=mapping.get(value,value)
  return prefix+quote+text+quote
 s=re.sub(r'(\b(?:label|textContent|title|placeholder)\s*:\s*|["\']aria-label["\']\s*:\s*|\b(?:alert|confirm)\(\s*)(["\'])([^"\'\r\n]+)\2',literal,s)
 if 'MediaBar' in p.name:
  for en in ('Plate','Marquee','Classic','Everything','Movies','TV shows','Even mix'):
   s=s.replace(', "'+en+'"]',', "'+mapping[en]+'"]')
  s=s.replace('<h2>Slideshow</h2>','<h2>横幅</h2>')
 target=p.parent.parent/'translated';target.mkdir(exist_ok=True)
 (target/p.name).write_text(s,encoding='utf-8')
