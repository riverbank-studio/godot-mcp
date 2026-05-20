extends Node

signal died
signal health_changed(new_health: int)

@export var max_health: int = 100
var _health: int = 100

func take_damage(amount: int) -> void:
	_health = clampi(_health - amount, 0, max_health)
	health_changed.emit(_health)
	if _health <= 0:
		# bug: died signal never emitted
		pass

func get_health() -> int:
	return _health
