extends CharacterBody2D

signal speed_changed(new_speed: float)

var current_speed: float = 200.0

func set_speed(new_speed: float) -> void:
	current_speed = new_speed
	speed_changed.emit(new_speed)

func _physics_process(_delta: float) -> void:
	var direction := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	velocity = direction * current_speed
	move_and_slide()
