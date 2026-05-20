class_name ArmoredEnemy
extends BaseEnemy

@export var armor: int = 50

func _ready() -> void:
	super()
	add_to_group("armored")

func take_damage(amount: int) -> void:
	var reduced := maxi(amount - armor, 0)
	super.take_damage(reduced)
