extends CharacterBody2D

func _physics_process(_delta: float) -> void:
	var direction := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	velocity = direction * 200.0
	move_and_slide()

func set_position_on_server(pos: Vector2) -> void:
	global_position = pos
