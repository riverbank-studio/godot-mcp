extends Node2D

signal enemy_detected(enemy: Node2D)

func _ready() -> void:
	$DetectionArea.collision_mask = 1 << 2  # layer 3 = bit index 2
	$DetectionArea.body_entered.connect(_on_body_entered)

func _on_body_entered(body: Node2D) -> void:
	if body.is_in_group("enemies"):
		enemy_detected.emit(body)
