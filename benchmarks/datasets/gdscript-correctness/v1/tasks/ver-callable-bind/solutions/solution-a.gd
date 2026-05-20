extends Node

func _ready() -> void:
	for i in 5:
		var button := $ItemContainer.get_child(i) as Button
		button.pressed.connect(_on_item_selected.bind(i))

func _on_item_selected(index: int) -> void:
	print("Selected item: %d" % index)
