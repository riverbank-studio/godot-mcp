extends Camera2D

@export var target: Node2D
@export var follow_speed: float = 5.0

func _process(delta: float) -> void:
	if not target:
		return
	global_position = global_position.lerp(target.global_position, follow_speed * delta)
