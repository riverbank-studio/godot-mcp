func filter_enemies(nodes: Array[Node]) -> Array[Node2D]:
	var result: Array[Node2D] = []
	for node in nodes:
		if node is Node2D:
			result.append(node as Node2D)
	return result
