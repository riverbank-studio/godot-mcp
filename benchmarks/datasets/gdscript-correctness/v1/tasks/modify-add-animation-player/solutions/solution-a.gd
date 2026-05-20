extends CharacterBody2D

@export var speed: float = 200.0

@onready var _anim: AnimationPlayer = $AnimationPlayer
@onready var _sprite: Sprite2D = $Sprite2D

func _physics_process(_delta: float) -> void:
	var direction := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	velocity = direction * speed
	move_and_slide()

	if velocity != Vector2.ZERO:
		if _anim.current_animation != "walk":
			_anim.play("walk")
	else:
		if _anim.current_animation != "idle":
			_anim.play("idle")

	if velocity.x < 0:
		_sprite.flip_h = true
	elif velocity.x > 0:
		_sprite.flip_h = false
