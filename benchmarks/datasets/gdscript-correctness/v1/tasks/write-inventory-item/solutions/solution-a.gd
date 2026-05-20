class_name InventoryItem
extends Resource

@export var item_name: String = ""
@export var max_stack: int = 99
@export var icon: Texture2D

func can_stack_with(other: InventoryItem) -> bool:
	return other.item_name == item_name and max_stack > 1
