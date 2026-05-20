extends CharacterBody2D

@export var speed: float = 100.0

func _ready() -> void:
	add_to_group("enemies")

func _physics_process(_delta: float) -> void:
	pass

func get_all_enemies(tree: SceneTree) -> Array[Node]:
	return tree.get_nodes_in_group("enemies")

func notify_enemies(message: String) -> void:
	get_tree().call_group("enemies", "receive_message", message)

func receive_message(message: String) -> void:
	print(message)
