extends CharacterBody2D

@export var speed: float = 400.0

func _ready() -> void:
	velocity = Vector2.RIGHT.rotated(rotation) * speed

func _physics_process(_delta: float) -> void:
	move_and_slide()
	if get_slide_collision_count() > 0:
		queue_free()
