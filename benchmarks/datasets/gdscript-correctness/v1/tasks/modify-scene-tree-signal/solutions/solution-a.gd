extends Node

var _tracked_enemies: Array[Node] = []

func _ready() -> void:
	get_tree().node_added.connect(_on_node_added)
	get_tree().node_removed.connect(_on_node_removed)

func _on_node_added(node: Node) -> void:
	if node.is_in_group("enemy"):
		_tracked_enemies.append(node)

func _on_node_removed(node: Node) -> void:
	if _tracked_enemies.has(node):
		_tracked_enemies.erase(node)

func get_enemy_count() -> int:
	return _tracked_enemies.size()
