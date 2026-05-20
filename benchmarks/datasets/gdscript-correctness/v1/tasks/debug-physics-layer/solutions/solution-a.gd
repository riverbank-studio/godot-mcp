## Enemies are on collision layer 3 (bit value = 4)
extends Area2D

signal enemy_entered(enemy: Node2D)

func _ready() -> void:
	collision_mask = 1 << 2  # layer 3 = bit index 2
	body_entered.connect(_on_body_entered)

func _on_body_entered(body: Node2D) -> void:
	if body.is_in_group("enemy"):
		enemy_entered.emit(body)
