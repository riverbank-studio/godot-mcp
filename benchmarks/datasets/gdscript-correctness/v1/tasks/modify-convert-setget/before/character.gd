extends Node

signal health_changed(new_health)

var max_health := 100
var health := 100 setget set_health, get_health

func set_health(value):
	health = clamp(value, 0, max_health)
	emit_signal("health_changed", health)

func get_health():
	return health
