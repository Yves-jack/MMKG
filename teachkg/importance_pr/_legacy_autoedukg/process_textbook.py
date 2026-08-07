import json
import re
import os
import sys
from biased_pagerank import load_graph, load_scores, calculate_global_importance


def clean_text(text):
    if not text:
        return ""
    text = text.lower()
    cleaned_parts = re.findall(r'[\u4e00-\u9fa5a-z0-9 ]+', text)
    return "".join(cleaned_parts)

def clean_toc_line(line):
    pattern = re.compile(r'^(#{1,6})\s+(.+)')
    match = re.match(pattern, line)
    if match:
        level = len(match.group(1))
        raw_content = match.group(2).strip()
    else:
        level = 0
        raw_content = line.strip()
    
    clean_pattern = r'^(?:第\d+章|[\d\.]+)\s*'
    content = re.sub(clean_pattern, '', raw_content).strip()
    return content, level

def load_kg_nodes(json_file):
    nodes = set()
    if not os.path.exists(json_file):
        print(f"Error: File {json_file} not found.")
        return nodes
        
    with open(json_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
        for item in data:
            if 'subject' in item:
                nodes.add(item['subject'])
            if 'object' in item:
                nodes.add(item['object'])
    return list(nodes)

def load_toc_structure(md_file):
    toc_items = []
    if not os.path.exists(md_file):
        print(f"Error: File {md_file} not found.")
        return toc_items

    with open(md_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line.startswith('#'):
                continue
            
            content, level = clean_toc_line(line)
            if not content:
                continue
            
            # Sub-titles logic as per request (Level 2 = Major, Level 3+ = Sub)
            if level <= 2:
                item_type = 'major'
                score = 20
            elif level >= 3:
                item_type = 'sub'
                score = 10
            else:
                continue 
            
            toc_items.append({
                'text': content,
                'cleaned': clean_text(content),
                'type': item_type,
                'score': score
            })
    return toc_items

def score_nodes(nodes, toc_items, threshold=0):
    """
    Score each node based on its appearance in TOC items.
    """
    node_scores = {}
    node_matchers = {}
    for node in nodes:
        parts = node.split('/')
        cleaned_parts = [clean_text(p) for p in parts if clean_text(p)]
        node_matchers[node] = cleaned_parts
    
    for node, match_parts in node_matchers.items():
        if not match_parts:
            continue
            
        current_score = 0
        for item in toc_items:
            toc_clean = item['cleaned']
            if not toc_clean:
                continue
            
            matched = False
            for part in match_parts:
                if part.isdigit():
                    continue
                
                if part in toc_clean:
                    matched = True
                    break
            
            if matched:
                current_score += item['score']
        
        if current_score >= threshold:
            node_scores[node] = current_score
            
    return node_scores

if __name__ == "__main__":
    # Allow running from project root or inside script dir
    # Default paths assume running from project root
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    
    md_path = os.path.join(base_dir, '目录.md')
    json_path = os.path.join(base_dir, 'relations_final.json')
    output_file = os.path.join(base_dir, 'node_scores.json')
    
    kg_nodes = load_kg_nodes(json_path)
    print(f"Found {len(kg_nodes)} unique nodes.")
    
    toc_structure = load_toc_structure(md_path)
    print(f"Found {len(toc_structure)} TOC items.")
    
    THRESHOLD = 10 
    scores = score_nodes(kg_nodes, toc_structure, threshold=THRESHOLD)
    
    sorted_scores = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    
    for node, score in sorted_scores[:10]:
        print(f"{node:<40} | {score}")
        
    with open(output_file, 'w', encoding='utf-8') as f:
        output_data = [{"node": k, "score": v} for k, v in sorted_scores]
        json.dump(output_data, f, indent=4, ensure_ascii=False)
    
    # ================= 5. Biased PageRank Calculation =================
    print("\n--- Step 2: Global Importance (Biased PageRank) ---")
    
    # Import necessary functions from biased_pagerank.py
    # Since we are in pipeline_scripts/ and biased_pagerank.py is in root, we need to handle path
    sys.path.append(base_dir) # base_dir is already set to project root

    


    output_csv = os.path.join(base_dir, 'biased_pagerank_results.csv') 
    output_json_pr = os.path.join(base_dir, 'biased_pagerank_results.json')

    G = load_graph(json_path)
    toc_scores = load_scores(output_file)
    
    if G and toc_scores:
        results = calculate_global_importance(G, toc_scores)
        
        # Output Results
        sorted_res = sorted(results.items(), key=lambda x: x[1]['final'], reverse=True)
        
        # Save to CSV
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

        # Save to JSON
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
    else:
        print("Failed to run PageRank due to missing graph or scores.")