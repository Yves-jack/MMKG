import json
import networkx as nx
import csv
import os

RELATION_WEIGHTS = {
    'part_of': 3.0,
    'belong_to': 3.0,
    'depend_on': 2.0,
    'property_of': 1.5,
    'synonym_of': 1.2,
    'related_with': 1.0
}

def load_graph(file_path):
    """Load the graph from the knowledge graph JSON file."""
    if not os.path.exists(file_path):
        print(f"Error: {file_path} not found.")
        return None
    
    with open(file_path, 'r', encoding='utf-8') as f:
        triples = json.load(f)
        
    G = nx.DiGraph()
    for item in triples:
        subj = item.get("subject")
        obj = item.get("object")
        pred = item.get("predicate", "related_with")
        
        # Determine weight
        weight = RELATION_WEIGHTS.get(pred, 1.0)
        
        # Ensure we have valid nodes
        if subj and obj:
            G.add_edge(subj, obj, weight=weight)
            # Add nodes explicitly in case they are isolated or only appear once
            G.add_node(subj)
            G.add_node(obj)
            
    return G

def load_scores(file_path):
    """Load the pre-calculated node scores from JSON."""
    if not os.path.exists(file_path):
        print(f"Error: {file_path} not found.")
        return {}
        
    with open(file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
        
    # Data is list of dicts: [{"node": "...", "score": ...}, ...]
    scores = {}
    for item in data:
        node = item.get("node")
        score = item.get("score", 0)
        if node and score > 0:
            scores[node] = score
            
    return scores

def run_biased_pagerank(G, scores, damping=0.85):
    """
    Run PageRank with personalization based on scores.
    Nodes not in 'scores' will have 0 personalization weight.
    """
    # 1. Prepare personalization vector
    # NetworkX expects a dictionary {node: weight}
    # Nodes missing from the dictionary are assigned 0 weight in personalization.
    
def calculate_global_importance(G, scores, damping=0.85):
    """
    Calculate Global Importance = Weighted Biased PageRank * (1 + Normalized K-Core)
    """
    
    # --- 1. Weighted Biased PageRank ---
    
    # Prepare personalization vector
    g_nodes = set(G.nodes())
    score_nodes = set(scores.keys())
    common_nodes = g_nodes.intersection(score_nodes)
    
    print(f"Graph nodes: {len(g_nodes)}")
    print(f"Scored nodes: {len(score_nodes)}")
    print(f"Nodes with bias scores in Graph: {len(common_nodes)}")
    
    if not common_nodes:
        print("Warning: No overlap. Running standard PageRank.")
        personalization = None
    else:
        personalization = {node: scores[node] for node in common_nodes}
        
    print("Running Biased PageRank (Weighted)...")
    pr_scores = nx.pagerank(G, alpha=damping, personalization=personalization, weight='weight')
    
    # --- 2. K-Core Decomposition ---
    
    print("Running K-Core Decomposition...")
    # Calculate core number for each node
    # Remove self-loops for core number if necessary? core_number handles directed graphs by using total degree usually, 
    # but networkx core_number implementation for directed graphs:
    # "The k-core is found by recursively removing nodes with degree less than k."
    # For directed graphs, it usually considers total degree (in+out) unless specified.
    # self-loops are handled.
    
    g_core = G.copy()
    g_core.remove_edges_from(nx.selfloop_edges(g_core)) # Remove self loops for core calc standard practice
    
    core_numbers = nx.core_number(g_core)
    max_k = max(core_numbers.values()) if core_numbers else 1
    print(f"Max K-Core: {max_k}")
    
    MAX_K_CORE = max_k # Store for potential reference
    max_pr = max(pr_scores.values()) if pr_scores else 1.0 # Avoid div/0
    print(f"Max PageRank: {max_pr}")
    
    # --- 3. Fuse Scores ---
    
    detailed_scores = {}
    for node, pr_val in pr_scores.items():
        k_val = core_numbers.get(node, 0)
        norm_k = k_val / max_k if max_k > 0 else 0
        norm_pr = pr_val / max_pr if max_pr > 0 else 0
        
        # Formula: Additive (0.7 * NormPR + 0.3 * NormK)
        # Adjusted according to user request: Lower K-Core weight to 0.3.
        final_val = 0.7 * norm_pr + 0.3 * norm_k
        
        detailed_scores[node] = {
            "final": final_val,
            "pr": pr_val,
            "k_core": k_val,
            "norm_k": norm_k,
            "norm_pr": norm_pr
        }
        
    return detailed_scores

if __name__ == "__main__":
    kg_file = "relations_final.json"
    scores_file = "node_scores.json"
    output_csv = "biased_pagerank_results.csv" 
    output_json = "biased_pagerank_results.json"
    
    # 1. Load Data
    print(f"Loading Graph from {kg_file}...")
    G = load_graph(kg_file)
    
    print(f"Loading Scores from {scores_file}...")
    toc_scores = load_scores(scores_file)
    
    if G and toc_scores:
        # 2. Calculate Importance
        results = calculate_global_importance(G, toc_scores)
        
        # 3. Output Results
        # Sort by Final score
        sorted_res = sorted(results.items(), key=lambda x: x[1]['final'], reverse=True)
        
        print(f"\nTop 50 Importance Scores:\n{'='*95}")
        print(f"{'Node':<30} | {'Final':<10} | {'PR(Raw)':<10} | {'NormPR':<6} | {'KCore':<5} | {'NormK':<6}")
        print(f"{'-'*30} | {'-'*10} | {'-'*10} | {'-'*6} | {'-'*5} | {'-'*6}")
        for node, data in sorted_res[:50]:
            print(f"{node:<30} | {data['final']:.6f}   | {data['pr']:.6f}   | {data['norm_pr']:.2f}   | {data['k_core']:<5} | {data['norm_k']:.2f}")
            
        # Save to CSV (Detailed)
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
        print(f"\nSaved detailed CSV results to {output_csv}")

        # Save to JSON (Compatible format + extra details)
        # growing_mindmap.py expects a list of objects with 'node' and 'score'.
        # We can add extra fields without breaking it.
        json_output = []
        for node, data in sorted_res:
            json_output.append({
                "node": node,
                "score": data['final'],
                "pr_score": data['pr'],
                "k_core": data['k_core']
            })
            
        with open(output_json, 'w', encoding='utf-8') as f:
            json.dump(json_output, f, indent=4, ensure_ascii=False)
        print(f"Saved JSON results to {output_json}")

