extends Node

func _ready() -> void:
	var player := AudioStreamPlayer.new()
	player.stream = load("res://sounds/music.ogg") as AudioStream
	player.bus = &"Music"
	player.autoplay = true
	add_child(player)
