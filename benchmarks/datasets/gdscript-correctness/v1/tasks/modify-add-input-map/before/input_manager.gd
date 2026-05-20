extends Node

func _process(_delta: float) -> void:
	if Input.is_action_just_pressed("jump"):
		print("jump pressed")
	if Input.is_action_just_pressed("attack"):
		print("attack pressed")
