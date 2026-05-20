extends Node

func _ready() -> void:
	randomize()  # unnecessary in Godot 4 — auto-seeded

func roll_dice() -> int:
	return randi_range(1, 6)
