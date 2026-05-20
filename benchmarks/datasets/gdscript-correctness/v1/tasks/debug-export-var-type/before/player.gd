extends CharacterBody2D

@export var speed: String = "200.0"  # bug: should be float

func _physics_process(_delta: float) -> void:
	var direction := Input.get_vector("ui_left", "ui_right", "ui_up", "ui_down")
	velocity = direction * float(speed)
	move_and_slide()
