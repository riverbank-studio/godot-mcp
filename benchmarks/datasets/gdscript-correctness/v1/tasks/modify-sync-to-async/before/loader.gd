extends Node

const texture_path := "res://assets/player.png"

func _ready() -> void:
	var texture: Texture2D = load(texture_path)
	$Sprite2D.texture = texture
