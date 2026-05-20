extends CharacterBody2D

@export var jump_velocity: float = -400.0
@export var speed: float = 200.0

var _gravity: float = ProjectSettings.get_setting("physics/2d/default_gravity")

func _physics_process(delta: float) -> void:
	if not is_on_floor():
		velocity.y += _gravity * delta

	if is_on_floor() and Input.is_action_just_pressed("ui_accept"):
		velocity.y = jump_velocity

	velocity.x = Input.get_axis("ui_left", "ui_right") * speed
	move_and_slide()
