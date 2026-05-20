extends Node2D

func play_death_and_free() -> void:
	$AnimationPlayer.play("death")
	await $AnimationPlayer.animation_finished
	queue_free()
