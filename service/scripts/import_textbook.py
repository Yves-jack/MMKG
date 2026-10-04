"""Load MMKG's textbook graph into a Canvas course without legacy KG inputs."""
import argparse
import hashlib
import json
from pathlib import Path
from mmkg_api.storage import GraphStore

def load_textbook(source: Path, target: Path, course_id: str):
    entities=json.loads((source/'entity_final.json').read_text(encoding='utf-8'))
    relations=json.loads((source/'relations_final.json').read_text(encoding='utf-8'))
    rankings=json.loads((source/'entity_sorted.json').read_text(encoding='utf-8'))
    importance=dict(rankings)
    ids={e['name']:'textbook:'+hashlib.sha256(e['name'].encode()).hexdigest()[:20] for e in entities}
    nodes=[{'id':ids[e['name']], 'name':e['name'], 'zh_name':e['name'].split('/')[0],
            'info':e.get('definition',''), 'definition':e.get('definition',''),
            'theorems':e.get('theorems',[]), 'importance':float(importance.get(e['name'],e.get('importance',0))),
            'source':'mmkg_textbook'} for e in entities]
    edges=[{'id':'textbook-edge:'+hashlib.sha256(json.dumps([i,r],sort_keys=True,ensure_ascii=False).encode()).hexdigest()[:20],
            'source':ids[r['subject']], 'target':ids[r['object']], 'relation':r['predicate'],
            'description':r.get('description',''), 'context':r.get('context',''), 'origin':'mmkg_textbook'}
           for i,r in enumerate(relations)]
    graph={'title':'离散数学（数理逻辑与集合论）','source':'mmkg_textbook',
           'source_files':['entity_final.json','relations_final.json','entity_sorted.json'],
           'nodes':nodes,'edges':edges}
    store=GraphStore(target)
    for view in ('base','document','video'):
        existing=store.read_view(course_id,view)
        if (existing['nodes'] or existing['edges']) and existing.get('source')!='mmkg_textbook':
            raise ValueError('Course contains another data source; clear it explicitly before textbook import')
    store.write_view(course_id,'base',graph)
    store.write_metadata(course_id,'config',{**store.read_metadata(course_id,'config',{}),'course_name':graph['title'],'source':'mmkg_textbook','textbook_directory':source.name})
    return {'course_id':course_id,'source':'mmkg_textbook','nodes':len(nodes),'edges':len(edges)}

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--source',type=Path,required=True)
    p.add_argument('--target',type=Path,required=True)
    p.add_argument('--course-id',required=True)
    a=p.parse_args()
    print(json.dumps(load_textbook(a.source,a.target,a.course_id),ensure_ascii=False))
