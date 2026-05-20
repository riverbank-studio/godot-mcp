extends Control

func build_menu(items: Array[String]) -> void:
	for item in items:
		var button := Button.new()
		button.text = item
		add_child(button)
