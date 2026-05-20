extends Node

var _pool: Array[Node] = []

func setup(scene: PackedScene, size: int) -> void:
	for i in size:
		var node := scene.instantiate()
		node.visible = false
		add_child(node)
		_pool.append(node)

func acquire() -> Node:
	for node in _pool:
		if not node.visible:
			node.visible = true
			return node
	return null

func release(node: Node) -> void:
	node.visible = false
	if node is Node2D:
		(node as Node2D).position = Vector2.ZERO
