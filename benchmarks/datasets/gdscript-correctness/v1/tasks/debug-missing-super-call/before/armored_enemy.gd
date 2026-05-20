## BaseEnemy._ready() sets up the navigation target — must be called
class_name ArmoredEnemy
extends BaseEnemy

@export var armor: int = 50

func _ready() -> void:
	# bug: super() not called — base class _ready() skipped
	add_to_group("armored")

func take_damage(amount: int) -> void:
	var reduced := maxi(amount - armor, 0)
	super.take_damage(reduced)
