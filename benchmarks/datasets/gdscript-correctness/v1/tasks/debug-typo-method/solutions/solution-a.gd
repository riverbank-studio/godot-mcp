extends Area2D

@export var lifetime: float = 3.0

func _ready() -> void:
	var timer := Timer.new()
	timer.wait_time = lifetime
	timer.one_shot = true
	timer.timeout.connect(queue_free)
	add_child(timer)
	timer.start()

func _on_body_entered(_body: Node2D) -> void:
	queue_free()
