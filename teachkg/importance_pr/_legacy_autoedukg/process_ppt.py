import json
import re
import os
import sys

# ================= 1. Helper Functions =================

def clean_text(text):
    if not text:
        return ""
    text = text.lower()
    cleaned_parts = re.findall(r'[\u4e00-\u9fa5a-z0-9]+', text)
    return "".join(cleaned_parts)

def clean_toc_line(line):
    line = line.strip()
    if not line.startswith('#'):
        return None, 0
    
    level = 0
    for char in line:
        if char == '#':
            level += 1
        else:
            break
            
    raw_content = line[level:].strip()
    
    # Remove chapter/section prefixes
    if level == 1:
        content = re.sub(r'^(第\s*\d+\s*[章课]|Chapter\s*\d+)\s*', '', raw_content).strip()
    else:
        content = re.sub(r'^[\d\.]+\s+', '', raw_content).strip()
        
    return content, level

# ================= 2. TOC Extraction Logic =================

def extract_toc(md_dir, output_file):
    print(f"Scanning directory: {md_dir}")
    
    if not os.path.exists(md_dir):
        print(f"Error: Directory {md_dir} does not exist.")
        return

    files = [f for f in os.listdir(md_dir) if f.endswith('.md')]
    
    # Sort files by Chapter Number
    def get_chapter_num(filename):
        match = re.search(r'第(\d+)[章课]', filename)
        if match:
            return int(match.group(1))
        return 999
        
    files.sort(key=get_chapter_num)
    
    full_toc = []

    for filename in files:
        filepath = os.path.join(md_dir, filename)
        try:
            chapter_num = get_chapter_num(filename)
        except:
            chapter_num = 0
            
        with open(filepath, 'r', encoding='utf-8') as f:
            lines = f.readlines()
            
        chapter_title = filename.replace('.md', '')
        # Try to find a better chapter title inside the file
        for line in lines:
            line = line.strip()
            if re.match(r'^#\s*第.*[章课]', line):
                chapter_title = line.lstrip('#').strip()
                break
        
        toc_entry = {
            'level': 1,
            'title': chapter_title,
            'children': []
        }
        
        seen_sections = set()
        
        # Regex to find X.Y section headers
        section_pattern = re.compile(rf'^\s*(?:##\s*)?({chapter_num}\.\d+)\s+(.*)$')
        
        for line in lines:
            line = line.strip()
            if not line: continue
            if line.startswith('!['): continue
            
            match = section_pattern.match(line)
            if match:
                sec_id = match.group(1)
                sec_title = match.group(2).strip()
                full_sec_title = f"{sec_id} {sec_title}"
                
                if full_sec_title not in seen_sections:
                    toc_entry['children'].append(full_sec_title)
                    seen_sections.add(full_sec_title)
        
        full_toc.append(toc_entry)

    # Output to File
    with open(output_file, 'w', encoding='utf-8') as f:
        for chapter in full_toc:
            f.write(f"# {chapter['title']}\n\n")
            for section in chapter['children']:
                f.write(f"## {section}\n\n") 
            f.write("\n")
            
    print(f"Successfully extracted TOC to {output_file}")

# ================= 3. Matching Logic (Longest Match Priority) =================

def build_alias_map(nodes):
    """
    Map: Cleaned Alias -> List of Nodes
    """
    alias_map = {}
    for node in nodes:
        parts = node.split('/')
        for p in parts:
            clean_p = clean_text(p)
            if not clean_p: continue
            if clean_p.isdigit(): continue
            if len(clean_p) < 2 and re.match(r'^[a-z0-9]+$', clean_p):
                continue
            
            if clean_p not in alias_map:
                alias_map[clean_p] = []
            alias_map[clean_p].append(node)
            
        # Also map full node name
        full_clean = clean_text(node)
        if full_clean and len(full_clean) >= 2:
            if full_clean not in alias_map:
                alias_map[full_clean] = []
            if node not in alias_map[full_clean]:
                alias_map[full_clean].append(node)
                
    return alias_map

def extract_entities_from_text(text, alias_map):
    """
    Find ALL KG nodes mentioned in text using Longest Match Priority.
    """
    clean_target = clean_text(text)
    if not clean_target: return set()
    
    # 1. Find all candidates
    candidates = []
    for alias in alias_map:
        if alias in clean_target:
            candidates.append(alias)
            
    # 2. Filter substrings (Longest Match)
    candidates.sort(key=len, reverse=True)
    
    final_aliases = set()
    for cand in candidates:
        is_substring = False
        for accepted in final_aliases:
            if cand in accepted:
                is_substring = True
                break
        if not is_substring:
            final_aliases.add(cand)
            
    # 3. Resolve nodes
    result_nodes = set()
    for alias in final_aliases:
        for node in alias_map[alias]:
            result_nodes.add(node)
            
    return result_nodes

# ================= 4. Scoring Logic =================

def score_nodes(nodes, toc_items, threshold=0):
    node_scores = {}
    
    # 1. Build Index
    alias_map = build_alias_map(nodes)
    
    # 2. Iterate TOC and assign scores
    for item in toc_items:
        toc_text = item['text']
        score_val = item['score']
        
        # Extract matched nodes using the logic
        matched_nodes = extract_entities_from_text(toc_text, alias_map)
        
        for node in matched_nodes:
            if node not in node_scores:
                node_scores[node] = 0
            node_scores[node] += score_val
            
    # Filter threshold
    final_scores = {k:v for k,v in node_scores.items() if v >= threshold}
    return final_scores

def load_kg_nodes(json_file):
    nodes = set()
    if not os.path.exists(json_file):
        return nodes
    with open(json_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
        for item in data:
            if 'subject' in item: nodes.add(item['subject'])
            if 'object' in item: nodes.add(item['object'])
    return list(nodes)

def load_toc_structure(md_file):
    toc_items = []
    if not os.path.exists(md_file):
        return toc_items
    with open(md_file, 'r', encoding='utf-8') as f:
        for line in f:
            content, level = clean_toc_line(line)
            if not content: continue
            score = 20 if level == 1 else 10
            toc_items.append({'text': content, 'score': score})
    return toc_items

# ================= 5. Main Execution =================

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python process_ppt.py <course_dir>")
        print("Example: python process_ppt.py ppt_resources1")
        sys.exit(1)
        
    course_dir = sys.argv[1]
    
    # Handle paths relative to project root
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    full_course_dir = os.path.join(base_dir, course_dir)
    
    # Define standard paths within course directory
    md_dir = os.path.join(full_course_dir, 'md')
    toc_file = os.path.join(full_course_dir, 'toc.md')
    kg_file = os.path.join(full_course_dir, 'relations_final.json')
    output_file = os.path.join(full_course_dir, 'node_scores.json')
    
    print(f"=== PPT Processing for: {course_dir} ===")
    print(f"Base Directory: {full_course_dir}")
    
    # Step 1: Extract TOC
    print("\n--- Step 1: Extracting TOC ---")
    extract_toc(md_dir, toc_file)
    
    # Step 2: Score Nodes
    print("\n--- Step 2: Scoring Nodes ---")
    
    print(f"Loading KG: {kg_file}")
    kg_nodes = load_kg_nodes(kg_file)
    print(f"KG Nodes: {len(kg_nodes)}")
    
    print(f"Loading TOC: {toc_file}")
    toc_data = load_toc_structure(toc_file)
    print(f"TOC Items: {len(toc_data)}")
    
    print("Calculating scores (Longest Match Priority)...")
    scores = score_nodes(kg_nodes, toc_data, threshold=10)
    
    sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    
    print(f"\nTop 10 Scored Nodes:")
    for n, s in sorted_scores[:10]:
        print(f"{n}: {s}")
        
    output_data = [{"node": k, "score": v} for k, v in sorted_scores]
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=4, ensure_ascii=False)
        
    print(f"\nSaved scores to {output_file}")

    # Step 3: Global Importance (PageRank)
    print("\n--- Step 3: Global Importance (Biased PageRank) ---")
    
    sys.path.append(base_dir)
    try:
        from biased_pagerank import load_graph, load_scores, calculate_global_importance
    except ImportError:
        print("Error: Could not import biased_pagerank from project root.")
        sys.exit(1)
        
    output_csv = os.path.join(full_course_dir, 'biased_pagerank_results.csv')
    output_json_pr = os.path.join(full_course_dir, 'biased_pagerank_results.json')
    
    print(f"Loading Graph from {kg_file}...")
    G = load_graph(kg_file)
    
    print(f"Loading Scores from {output_file}...")
    toc_scores = load_scores(output_file)
    
    if G and toc_scores:
        print("Calculating Global Importance...")
        results = calculate_global_importance(G, toc_scores)
        
        sorted_res = sorted(results.items(), key=lambda x: x[1]['final'], reverse=True)
        
        import csv
        with open(output_csv, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(["Node", "FinalScore", "WeightedPageRank", "NormalizedPageRank", "KCore", "NormalizedKCore"])
            for node, data in sorted_res:
                writer.writerow([
                    node, 
                    data['final'], 
                    data['pr'], 
                    data['norm_pr'],
                    data['k_core'], 
                    data['norm_k']
                ])
        print(f"Saved detailed CSV results to {output_csv}")

        json_output = []
        for node, data in sorted_res:
            json_output.append({
                "node": node,
                "score": data['final'],
                "pr_score": data['pr'],
                "k_core": data['k_core']
            })
            
        with open(output_json_pr, 'w', encoding='utf-8') as f:
            json.dump(json_output, f, indent=4, ensure_ascii=False)
        print(f"Saved JSON results to {output_json_pr}")
