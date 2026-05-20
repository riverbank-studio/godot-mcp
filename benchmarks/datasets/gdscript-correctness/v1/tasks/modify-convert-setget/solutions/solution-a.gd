extends Node

signal health_changed(new_health: int)

var max_health: int = 100
var health: int = 100:
	set(value):
		health = clampi(value, 0, max_health)
		health_changed.emit(health)
	get:
		return health
