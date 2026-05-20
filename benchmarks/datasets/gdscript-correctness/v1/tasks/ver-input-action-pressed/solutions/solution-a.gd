extends CharacterBody2D

@export var jump_velocity: float = -400.0
@export var run_speed: float = 300.0
@export var walk_speed: float = 200.0

func _physics_process(delta: float) -> void:
	if Input.is_action_just_pressed("jump") and is_on_floor():
		velocity.y = jump_velocity

	var speed := run_speed if is_holding_run() else walk_speed
	velocity.x = Input.get_axis("ui_left", "ui_right") * speed
	move_and_slide()

func is_holding_run() -> bool:
	return Input.is_action_pressed("run")
