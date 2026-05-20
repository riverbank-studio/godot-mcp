extends Node

func _ready() -> void:
	$Timer.timeout.connect(_on_timer_timeout)

func disconnect_timer() -> void:
	$Timer.timeout.disconnect(_on_timer_timeout)

func _on_timer_timeout() -> void:
	print("timer fired")
